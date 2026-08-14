import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runProcess } from '../core/process.js';

const PROVIDER = 'graphify';
const DEFAULT_GRAPH = 'graphify-out/graph.json';
const TRAVERSAL_BOUNDS = Object.freeze({ timeoutMs: 30_000, maxBytes: 256 * 1024 });
const STATUS_BOUNDS = Object.freeze({ timeoutMs: 10_000, maxBytes: 64 * 1024 });

function providerError(code, message, { retryable = false, exitCode } = {}) {
  return new AxiError(code, message, {
    retryable,
    details: { provider: PROVIDER, ...(exitCode === undefined ? {} : { exitCode }) },
  });
}

function sanitizeProviderError(error) {
  if (error?.code === 'adapter-unavailable') {
    return providerError('adapter-unavailable', 'Graphify CLI is unavailable');
  }
  if (error?.code === 'provider-timeout') {
    return providerError('provider-timeout', 'Graphify command timed out', { retryable: true });
  }
  if (error?.code === 'provider-output-limit') {
    return providerError('provider-output-limit', 'Graphify command exceeded the output limit');
  }
  if (error?.code === 'provider-invalid-response') {
    return providerError('provider-invalid-response', 'Graphify returned an invalid response', { retryable: true });
  }
  return providerError('graphify-error', 'Graphify command failed', { retryable: true });
}

export function validateKnowledgeText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid('invalid-arguments', `${name} must be non-empty`);
  }
  if (value.includes('\0')) throw invalid('invalid-arguments', `${name} must not contain NUL`);
  return value;
}

function validateInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid('invalid-number', `${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function graphCandidate(graph, cwd) {
  return path.resolve(cwd, graph === undefined ? DEFAULT_GRAPH : graph);
}

async function graphExists(graph, cwd) {
  try {
    return (await fs.stat(graphCandidate(graph, cwd))).isFile();
  } catch {
    return false;
  }
}

async function resolveGraph(graph, cwd) {
  try {
    const resolved = await fs.realpath(graphCandidate(graph, cwd));
    if (!(await fs.stat(resolved)).isFile()) throw new Error('not a regular file');
    return resolved;
  } catch {
    throw invalid('invalid-graph', 'Graph must be an existing regular file');
  }
}

async function invoke(args, bounds, { resolver = resolveExecutable, runner = runProcess } = {}) {
  let executable;
  try {
    executable = await resolver(PROVIDER);
  } catch {
    throw providerError('adapter-unavailable', 'Graphify CLI is unavailable');
  }
  if (!executable) throw providerError('adapter-unavailable', 'Graphify CLI is unavailable');
  let result;
  try {
    result = await runner(executable, args, bounds);
  } catch (error) {
    throw sanitizeProviderError(error);
  }
  if (!result || result.code !== 0) {
    throw providerError('graphify-error', 'Graphify command failed', {
      retryable: true,
      ...(Number.isInteger(result?.code) ? { exitCode: result.code } : {}),
    });
  }
  const text = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!text) throw providerError('provider-invalid-response', 'Graphify returned an invalid response', { retryable: true });
  return text;
}

function traversalResult(text) {
  return { data: { text }, meta: { characters: text.length, empty: false } };
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactGraphPath(text, resolvedGraph) {
  const nativeVariants = [
    resolvedGraph,
    resolvedGraph.replaceAll('\\', '/'),
    resolvedGraph.replaceAll('/', '\\'),
  ];
  if (process.platform === 'win32' && !resolvedGraph.startsWith('\\\\?\\')) {
    nativeVariants.push(`\\\\?\\${resolvedGraph}`);
  }
  const variants = new Set([
    ...nativeVariants,
    pathToFileURL(resolvedGraph).href,
    ...nativeVariants.map((value) => JSON.stringify(value).slice(1, -1)),
  ]);
  let redacted = text;
  for (const value of [...variants].sort((left, right) => right.length - left.length)) {
    if (value) redacted = redacted.replace(new RegExp(escapedRegExp(value), 'gi'), '[graph]');
  }
  return redacted;
}

function parseVersion(text) {
  const match = text.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match?.[1];
}

export async function knowledgeStatus(graph, {
  cwd = process.cwd(),
  resolver = resolveExecutable,
  runner = runProcess,
} = {}) {
  const exists = await graphExists(graph, cwd);
  let executable;
  try {
    executable = await resolver(PROVIDER);
  } catch {
    throw providerError('adapter-unavailable', 'Graphify CLI is unavailable');
  }
  if (!executable) return { data: { available: false, graphExists: exists }, meta: { empty: false } };
  let text;
  try {
    text = await invoke(['--version'], STATUS_BOUNDS, { resolver: async () => executable, runner });
  } catch (error) {
    throw sanitizeProviderError(error);
  }
  const version = parseVersion(text);
  return {
    data: { available: true, ...(version ? { version } : {}), graphExists: exists },
    meta: { empty: false },
  };
}

export async function knowledgeQuery(question, {
  graph,
  budget = 300,
  cwd = process.cwd(),
} = {}, options = {}) {
  validateKnowledgeText(question, 'question');
  validateInteger(budget, 'budget', 50, 2000);
  const resolvedGraph = await resolveGraph(graph, cwd);
  const text = await invoke(['query', question, '--budget', String(budget), '--graph', resolvedGraph], TRAVERSAL_BOUNDS, options);
  return traversalResult(redactGraphPath(text, resolvedGraph));
}

export async function knowledgePath(from, to, {
  graph,
  cwd = process.cwd(),
} = {}, options = {}) {
  validateKnowledgeText(from, 'from');
  validateKnowledgeText(to, 'to');
  const resolvedGraph = await resolveGraph(graph, cwd);
  const text = await invoke(['path', from, to, '--graph', resolvedGraph], TRAVERSAL_BOUNDS, options);
  return traversalResult(redactGraphPath(text, resolvedGraph));
}

export async function knowledgeAffected(node, {
  graph,
  depth = 2,
  cwd = process.cwd(),
} = {}, options = {}) {
  validateKnowledgeText(node, 'node');
  validateInteger(depth, 'depth', 1, 6);
  const resolvedGraph = await resolveGraph(graph, cwd);
  const text = await invoke(['affected', node, '--depth', String(depth), '--graph', resolvedGraph], TRAVERSAL_BOUNDS, options);
  return traversalResult(redactGraphPath(text, resolvedGraph));
}
