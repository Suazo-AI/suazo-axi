import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runProcess } from '../core/process.js';

const PROVIDER = 'cgr';

// `cgr` talks to Memgraph over bolt on every call, so even `status` pays a
// connection handshake. `dead-code` walks the whole reachability graph, which is
// why it gets its own, much larger budget.
const STATUS_BOUNDS = Object.freeze({ timeoutMs: 30_000, maxBytes: 64 * 1024 });
const STATS_BOUNDS = Object.freeze({ timeoutMs: 30_000, maxBytes: 64 * 1024 });
const DEAD_CODE_BOUNDS = Object.freeze({ timeoutMs: 300_000, maxBytes: 4 * 1024 * 1024 });

// A cgr project key is "<repo-name>__<8 hex>". Anything else is a caller mistake,
// not a provider failure, so it is rejected before a process is spawned.
const PROJECT_NAME = /^[A-Za-z0-9._-]+$/;

function providerError(code, message, { retryable = false, exitCode } = {}) {
  return new AxiError(code, message, {
    retryable,
    details: { provider: PROVIDER, ...(exitCode === undefined ? {} : { exitCode }) },
  });
}

function sanitizeProviderError(error) {
  if (error?.code === 'adapter-unavailable') {
    return providerError('adapter-unavailable', 'Code-graph CLI is unavailable');
  }
  if (error?.code === 'provider-timeout') {
    return providerError('provider-timeout', 'Code-graph command timed out', { retryable: true });
  }
  if (error?.code === 'provider-output-limit') {
    return providerError('provider-output-limit', 'Code-graph command exceeded the output limit');
  }
  if (error?.code === 'provider-invalid-response') {
    return providerError('provider-invalid-response', 'Code-graph returned an invalid response', { retryable: true });
  }
  return providerError('codegraph-error', 'Code-graph command failed', { retryable: true });
}

export function validateProjectName(value, name = 'project') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid('invalid-arguments', `${name} must be non-empty`);
  }
  if (!PROJECT_NAME.test(value)) {
    throw invalid('invalid-arguments', `${name} must match ${PROJECT_NAME.source}`);
  }
  return value;
}

function validateInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid('invalid-number', `${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

async function invoke(args, bounds, { resolver = resolveExecutable, runner = runProcess } = {}) {
  let executable;
  try {
    executable = await resolver(PROVIDER);
  } catch {
    throw providerError('adapter-unavailable', 'Code-graph CLI is unavailable');
  }
  if (!executable) throw providerError('adapter-unavailable', 'Code-graph CLI is unavailable');
  let result;
  try {
    result = await runner(executable, args, bounds);
  } catch (error) {
    throw sanitizeProviderError(error);
  }
  if (!result || result.code !== 0) {
    throw providerError('codegraph-error', 'Code-graph command failed', {
      retryable: true,
      ...(Number.isInteger(result?.code) ? { exitCode: result.code } : {}),
    });
  }
  const text = typeof result.stdout === 'string' ? result.stdout : '';
  if (!text.trim()) throw providerError('provider-invalid-response', 'Code-graph returned an invalid response', { retryable: true });
  return text;
}

// `cgr` renders boxes and progress with ANSI even under `-q` on some terminals.
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '');
}

function normalizeCount(value) {
  const parsed = Number.parseInt(String(value).replaceAll(',', ''), 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function parseReachable(text, service) {
  const match = text.match(new RegExp(`${service}=\\S+\\s+reachable=(True|False)`, 'i'));
  return match ? match[1].toLowerCase() === 'true' : false;
}

function parseProjects(text) {
  const projects = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*-\s+(\S+):\s+last sync\s+(\S+)/);
    if (match) projects.push({ name: match[1], lastSync: match[2] });
  }
  return projects;
}

// The two tables share a row shape, so the relationship header is the only
// boundary between them. Splitting on it keeps one parser instead of two.
function parseCountTable(section) {
  const counts = {};
  for (const line of section.split('\n')) {
    const match = line.match(/^\|\s*([A-Za-z][A-Za-z _-]*?)\s*\|\s*([\d,]+)\s*\|/);
    if (!match) continue;
    const label = match[1].trim();
    if (/^(Node Type|Relationship Type|Total Nodes|Total Relationships)$/i.test(label)) continue;
    counts[label] = normalizeCount(match[2]);
  }
  return counts;
}

function parseTotal(section, label) {
  const match = section.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*([\\d,]+)\\s*\\|`, 'i'));
  return match ? normalizeCount(match[1]) : 0;
}

export async function codegraphStatus(options = {}) {
  const { resolver = resolveExecutable, runner = runProcess } = options;
  let executable;
  try {
    executable = await resolver(PROVIDER);
  } catch {
    throw providerError('adapter-unavailable', 'Code-graph CLI is unavailable');
  }
  if (!executable) {
    return { data: { available: false, stackRunning: false, projects: [] }, meta: { total: 0, empty: true } };
  }

  const text = stripAnsi(await invoke(['-q', 'status'], STATUS_BOUNDS, { resolver: async () => executable, runner }));
  const stackRunning = /^stack:\s+running/mi.test(text);
  const projects = parseProjects(text);
  return {
    data: {
      available: true,
      stackRunning,
      memgraphReachable: parseReachable(text, 'memgraph'),
      qdrantReachable: parseReachable(text, 'qdrant'),
      projects,
    },
    meta: { total: projects.length, empty: projects.length === 0 },
  };
}

export async function codegraphStats(options = {}) {
  const text = stripAnsi(await invoke(['-q', 'stats'], STATS_BOUNDS, options));
  const [nodeSection, relationshipSection = ''] = text.split(/Relationship Statistics/i);
  const nodes = parseCountTable(nodeSection);
  const relationships = parseCountTable(relationshipSection);
  const totalNodes = parseTotal(nodeSection, 'Total Nodes');
  const totalRelationships = parseTotal(relationshipSection, 'Total Relationships');
  return {
    data: { nodes, relationships, totalNodes, totalRelationships },
    meta: { total: totalNodes + totalRelationships, empty: totalNodes === 0 },
  };
}

export async function codegraphDeadCode(project, { limit = 50, includeClasses = false } = {}, options = {}) {
  validateProjectName(project);
  validateInteger(limit, 'limit', 1, 500);
  const args = ['-q', 'dead-code', '-n', project, '--format', 'json'];
  if (includeClasses) args.push('--classes');

  const text = await invoke(args, DEAD_CODE_BOUNDS, options);
  let parsed;
  try {
    parsed = JSON.parse(stripAnsi(text));
  } catch {
    throw providerError('provider-invalid-response', 'Code-graph returned an invalid response', { retryable: true });
  }
  if (!Array.isArray(parsed)) {
    throw providerError('provider-invalid-response', 'Code-graph returned an invalid response', { retryable: true });
  }

  // The aggregate counts the whole report; `symbols` is the truncated view. Reporting
  // both means a caller never mistakes the page for the total.
  const symbols = parsed.slice(0, limit).map((item) => ({
    name: typeof item?.name === 'string' ? item.name : '',
    qualifiedName: typeof item?.qualified_name === 'string' ? item.qualified_name : '',
    kind: typeof item?.label === 'string' ? item.label : '',
    startLine: Number.isSafeInteger(item?.start_line) ? item.start_line : null,
  }));

  return {
    data: { project, symbols, truncated: parsed.length > symbols.length },
    meta: { total: parsed.length, returned: symbols.length, empty: parsed.length === 0 },
  };
}
