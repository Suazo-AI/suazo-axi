import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runJsonCli } from '../core/cli-provider.js';

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_MAP_LIMIT = 100;
const MAX_LIMIT = 100;
const OUTPUT_CAP_BYTES = 512_000;

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function compactText(value, maxLength = 2_048) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maxLength) return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizedUrl(value) {
  const text = compactText(value, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

// The query is passed to `firecrawl search` as a positional, so a leading hyphen is read by the
// provider CLI as a flag: `--query "-h"` printed its help instead of searching, and `--query
// "--api-url"` would swallow the next argument. The `--` separator does not help, because the CLI
// still parses `-h` after it. Rejecting the shape at the boundary is the only guard that holds,
// and it matches how the job id is validated in higgsfield.js. Notion needs no equivalent: its
// query travels inside a JSON body via `-d`, where it can never be read as a flag.
export function validateQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 512 || query.includes('\0') || query.startsWith('-')) {
    throw invalid('invalid-query', 'query must be non-empty, at most 512 characters, contain no NUL, and not start with a hyphen');
  }
  return query;
}

export function validateUrl(url) {
  if (!normalizedUrl(url)) {
    throw invalid('invalid-url', 'url must be an http or https URL of at most 2048 characters with no NUL');
  }
  return url;
}

export function validateLimit(limit, fallback = DEFAULT_SEARCH_LIMIT) {
  const normalized = limit === undefined ? fallback : limit;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > MAX_LIMIT) {
    throw invalid('invalid-limit', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return normalized;
}

function responseItems(value, { map = false } = {}) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || value.success === false) {
    throw new AxiError('provider-invalid-response', 'Firecrawl returned an invalid list response');
  }
  if (value.success === true && Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.data?.web)) return value.data.web;
  if (map && Array.isArray(value.data?.links)) return value.data.links;
  throw new AxiError('provider-invalid-response', 'Firecrawl returned a non-list response');
}

export function normalizeStatus(value) {
  const source = value?.success === true && value.data && typeof value.data === 'object' && !Array.isArray(value.data)
    ? value.data
    : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new AxiError('provider-invalid-response', 'Firecrawl returned an invalid status');
  }
  const creditsRemaining = source.remainingCredits ?? source.creditsRemaining;
  if (typeof creditsRemaining !== 'number' || !Number.isFinite(creditsRemaining) || creditsRemaining < 0) {
    throw new AxiError('provider-invalid-response', 'Firecrawl returned an incomplete status');
  }
  return { available: true, authenticated: true, creditsRemaining };
}

export function normalizeSearch(value) {
  const items = responseItems(value).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AxiError('provider-invalid-response', 'Firecrawl returned an invalid search item');
    }
    const normalized = {
      title: compactText(item.title, 1_000),
      url: normalizedUrl(item.url),
      description: compactText(item.description ?? item.snippet, 4_000),
    };
    if (!normalized.url) throw new AxiError('provider-invalid-response', 'Firecrawl returned an incomplete search item');
    return normalized;
  });
  return { items };
}

export function normalizeMap(value) {
  const items = responseItems(value, { map: true }).map((item) => {
    const url = normalizedUrl(typeof item === 'string' ? item : item?.url);
    if (!url) throw new AxiError('provider-invalid-response', 'Firecrawl returned an incomplete map item');
    return { url };
  });
  return { items };
}

export async function resolveFirecrawlTransport({
  resolver = resolveExecutable,
  platform = process.platform,
  fileExists = exists,
  nodePath = process.execPath,
} = {}) {
  const executable = await resolver('firecrawl');
  if (!executable) throw new AxiError('adapter-unavailable', 'Firecrawl CLI is unavailable');
  if (platform !== 'win32' || !/\.(?:cmd|bat|ps1)$/i.test(executable)) {
    return { file: executable, prefixArgs: [], source: 'direct-cli' };
  }
  const nodeEntry = path.join(path.dirname(executable), 'node_modules', 'firecrawl-cli', 'dist', 'index.js');
  if (await fileExists(nodeEntry)) return { file: nodePath, prefixArgs: [nodeEntry], source: 'node-cli' };
  throw new AxiError('adapter-unavailable', 'Firecrawl CLI launcher is unavailable');
}

async function invoke(args, { transportResolver = resolveFirecrawlTransport, runner } = {}) {
  const transport = await transportResolver();
  return runJsonCli({
    provider: 'firecrawl',
    file: transport.file,
    prefixArgs: transport.prefixArgs,
    args,
    timeoutMs: 20_000,
    maxBytes: OUTPUT_CAP_BYTES,
    runner,
  });
}

export async function firecrawlStatus(options = {}) {
  try {
    const value = await invoke(['credit-usage', '--json'], options);
    return { data: normalizeStatus(value), meta: { empty: false } };
  } catch (error) {
    const base = { creditsRemaining: null };
    if (error.code === 'adapter-unavailable') {
      return { data: { available: false, authenticated: false, ...base }, meta: { empty: false } };
    }
    if (error.code === 'firecrawl-error') {
      return { data: { available: true, authenticated: false, ...base }, meta: { empty: false } };
    }
    return { data: { available: true, authenticated: false, ...base, degraded: true }, meta: { empty: false } };
  }
}

export async function firecrawlSearch(query, limit = DEFAULT_SEARCH_LIMIT, options = {}) {
  validateQuery(query);
  validateLimit(limit);
  const value = await invoke(['search', query, '--limit', String(limit), '--json'], options);
  const normalized = normalizeSearch(value);
  const items = normalized.items.slice(0, limit);
  return {
    data: { items },
    meta: { returned: items.length, limit, truncated: normalized.items.length > limit, totalKnown: false, empty: items.length === 0 },
  };
}

export async function firecrawlMap(url, limit = DEFAULT_MAP_LIMIT, options = {}) {
  validateUrl(url);
  validateLimit(limit, DEFAULT_MAP_LIMIT);
  const value = await invoke(['map', url, '--limit', String(limit), '--json'], options);
  const normalized = normalizeMap(value);
  const items = normalized.items.slice(0, limit);
  return {
    data: { items },
    meta: { returned: items.length, limit, truncated: normalized.items.length > limit, totalKnown: false, empty: items.length === 0 },
  };
}
