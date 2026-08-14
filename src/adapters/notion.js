import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runJsonCli } from '../core/cli-provider.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const OUTPUT_CAP_BYTES = 512_000;
const UUID_PATTERN = /^(?:[A-Fa-f0-9]{32}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12})$/;

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function compactText(value, maxLength = 2_048) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maxLength) return null;
  const normalized = value.trim();
  return normalized || null;
}

export function validateQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > 512 || query.includes('\0')) {
    throw invalid('invalid-query', 'query must be non-empty, at most 512 characters, and contain no NUL');
  }
  return query;
}

export function validateLimit(limit = DEFAULT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalid('invalid-limit', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

export function validatePageId(id) {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw invalid('invalid-page-id', 'id must be a 32-hex Notion UUID, with or without hyphens');
  }
  return id;
}

export function notionTitle(value) {
  const properties = value?.properties;
  const fragments = properties?.title?.title ?? properties?.Name?.title;
  if (!Array.isArray(fragments)) return null;
  const title = fragments.map((item) => typeof item?.plain_text === 'string' ? item.plain_text : '').join('').trim();
  return title || null;
}

export function normalizeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AxiError('provider-invalid-response', 'Notion returned an invalid status');
  }
  const botId = compactText(value.id, 128);
  const workspaceName = compactText(value.bot?.workspace_name ?? value.workspace_name, 200);
  if (!botId || !workspaceName) {
    throw new AxiError('provider-invalid-response', 'Notion returned an incomplete status');
  }
  return { available: true, authenticated: true, botId, workspaceName };
}

function normalizeSearchItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AxiError('provider-invalid-response', 'Notion returned an invalid search item');
  }
  const item = {
    id: compactText(value.id, 128),
    title: notionTitle(value),
    object: compactText(value.object, 32),
    url: compactText(value.url),
    lastEditedAt: compactText(value.last_edited_time, 128),
  };
  if (!item.id || !item.object || !item.url || !item.lastEditedAt) {
    throw new AxiError('provider-invalid-response', 'Notion returned an incomplete search item');
  }
  return item;
}

export function normalizeSearch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.results)) {
    throw new AxiError('provider-invalid-response', 'Notion returned a non-list search response');
  }
  return { items: value.results.map(normalizeSearchItem) };
}

export function normalizePage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AxiError('provider-invalid-response', 'Notion returned an invalid page');
  }
  const page = {
    id: compactText(value.id, 128),
    title: notionTitle(value),
    url: compactText(value.url),
    createdAt: compactText(value.created_time, 128),
    lastEditedAt: compactText(value.last_edited_time, 128),
    // The current API returns `is_archived` (alongside `in_trash`); `archived` is the legacy name.
    archived: typeof value.is_archived === 'boolean'
      ? value.is_archived
      : typeof value.archived === 'boolean' ? value.archived : null,
  };
  if (!page.id || !page.url || !page.createdAt || !page.lastEditedAt || page.archived === null) {
    throw new AxiError('provider-invalid-response', 'Notion returned an incomplete page');
  }
  return page;
}

export async function resolveNotionTransport({
  resolver = resolveExecutable,
  platform = process.platform,
  fileExists = exists,
  nodePath = process.execPath,
} = {}) {
  const executable = await resolver('ntn');
  if (!executable) throw new AxiError('adapter-unavailable', 'Notion CLI is unavailable');
  if (platform !== 'win32' || !/\.(?:cmd|bat|ps1)$/i.test(executable)) {
    return { file: executable, prefixArgs: [], source: 'direct-cli' };
  }

  // Past this point the layout is a Windows shim's, so the joins must be Windows joins regardless
  // of the host. Using the host `path` here works on Windows by luck and cannot work anywhere
  // else: posix dirname('C:\\npm\\ntn.ps1') is '.', so the resolved entry never matches.
  const base = path.win32.dirname(executable);
  if (/\.ps1$/i.test(executable)) {
    for (const nativeEntry of [
      path.win32.join(base, 'node_modules', 'ntn', 'bin', 'ntn.exe'),
      path.win32.join(base, 'node_modules', 'ntn', 'dist', 'ntn-win32-x64', 'ntn.exe'),
    ]) {
      if (await fileExists(nativeEntry)) return { file: nativeEntry, prefixArgs: [], source: 'native-cli' };
    }
  }

  const nodeEntry = path.win32.join(base, 'node_modules', 'ntn', 'bin', 'ntn');
  if (await fileExists(nodeEntry)) return { file: nodePath, prefixArgs: [nodeEntry], source: 'node-cli' };
  throw new AxiError('adapter-unavailable', 'Notion CLI launcher is unavailable');
}

async function invoke(args, { transportResolver = resolveNotionTransport, runner } = {}) {
  const transport = await transportResolver();
  return runJsonCli({
    provider: 'notion',
    file: transport.file,
    prefixArgs: transport.prefixArgs,
    args,
    timeoutMs: 20_000,
    maxBytes: OUTPUT_CAP_BYTES,
    runner,
  });
}

export async function notionStatus(options = {}) {
  try {
    const value = await invoke(['api', '/v1/users/me'], options);
    return { data: normalizeStatus(value), meta: { empty: false } };
  } catch (error) {
    const base = { botId: null, workspaceName: null };
    if (error.code === 'adapter-unavailable') {
      return { data: { available: false, authenticated: false, ...base }, meta: { empty: false } };
    }
    if (error.code === 'notion-error') {
      return { data: { available: true, authenticated: false, ...base }, meta: { empty: false } };
    }
    return { data: { available: true, authenticated: false, ...base, degraded: true }, meta: { empty: false } };
  }
}

export async function notionSearch(query, limit = DEFAULT_LIMIT, options = {}) {
  validateQuery(query);
  validateLimit(limit);
  const value = await invoke(['api', '/v1/search', '-d', JSON.stringify({ query, page_size: limit })], options);
  const data = normalizeSearch(value);
  return {
    data,
    meta: { returned: data.items.length, limit, truncated: false, totalKnown: false, empty: data.items.length === 0 },
  };
}

export async function notionPageView(id, options = {}) {
  validatePageId(id);
  const value = await invoke(['api', `/v1/pages/${id}`], options);
  return { data: normalizePage(value), meta: { empty: false } };
}
