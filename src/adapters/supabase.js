import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runJsonCli } from '../core/cli-provider.js';

const LOCAL_ENTRY = fileURLToPath(new URL('../../node_modules/supabase/dist/supabase.js', import.meta.url));
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STATUS_TIMEOUT_MS = 20_000;
const PROJECTS_TIMEOUT_MS = 20_000;
const OUTPUT_CAP_BYTES = 512_000;

const STATUS_ENDPOINTS = [
  ['API_URL', 'api'],
  ['GRAPHQL_URL', 'graphql'],
  ['STORAGE_URL', 'storage'],
  ['S3_STORAGE_URL', 's3Storage'],
  ['STUDIO_URL', 'studio'],
  ['INBUCKET_URL', 'inbucket'],
  ['MAILPIT_URL', 'mailpit'],
];

async function exists(file, access) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function resolveSupabaseTransport({
  resolver = resolveExecutable,
  access = fs.access,
  localEntry = LOCAL_ENTRY,
  platform = process.platform,
  node = process.execPath,
} = {}) {
  if (await exists(localEntry, access)) {
    return { file: node, prefixArgs: [localEntry], source: 'local-cli' };
  }

  const executable = await resolver('supabase');
  if (!executable) throw new AxiError('adapter-unavailable', 'Supabase CLI is unavailable');

  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const globalEntry = path.join(path.dirname(executable), 'node_modules', 'supabase', 'dist', 'supabase.js');
    if (await exists(globalEntry, access)) {
      return { file: node, prefixArgs: [globalEntry], source: 'global-cli' };
    }
    throw new AxiError('adapter-unavailable', 'Supabase CLI launcher is unavailable');
  }

  return { file: executable, prefixArgs: [], source: 'global-cli' };
}

function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '0.0.0.0' && hostname !== '[::1]') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function compactText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function compactState(value) {
  const normalized = compactText(value, 64);
  return normalized ? normalized.toLowerCase() : null;
}

export function normalizeStatus(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const services = {};
  for (const [providerKey, outputKey] of STATUS_ENDPOINTS) {
    const endpoint = normalizeEndpoint(source[providerKey]);
    if (endpoint) services[outputKey] = endpoint;
  }
  return { running: true, services };
}

export function normalizeProject(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const organization = source.organization && typeof source.organization === 'object' && !Array.isArray(source.organization)
    ? source.organization
    : {};
  const organizationId = compactText(source.organization_id ?? source.organizationId ?? organization.id, 128);
  const organizationName = compactText(
    source.organization_name ?? source.organizationName ?? organization.name ?? organization.slug,
    200,
  );
  const providerStatus = compactState(source.status ?? source.state);
  const statusHealth = providerStatus?.match(/^(.*)_(unhealthy|healthy)$/);

  return {
    ref: compactText(source.ref, 128),
    id: compactText(source.id, 128),
    name: compactText(source.name, 200),
    region: compactText(source.region, 64),
    status: statusHealth ? statusHealth[1] : providerStatus,
    health: compactState(source.health) ?? statusHealth?.[2] ?? null,
    organization: organizationId || organizationName ? { id: organizationId, name: organizationName } : null,
  };
}

function validateWorkdir(workdir) {
  if (typeof workdir !== 'string' || !workdir.trim() || workdir.includes('\0')) {
    throw invalid('invalid-workdir', 'workdir must be a non-empty local path');
  }
}

export function validateLimit(limit = DEFAULT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalid('invalid-limit', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

async function invoke(args, timeoutMs, { transportResolver = resolveSupabaseTransport, runner } = {}) {
  const transport = await transportResolver();
  return runJsonCli({
    provider: 'supabase',
    file: transport.file,
    prefixArgs: transport.prefixArgs,
    args,
    timeoutMs,
    maxBytes: OUTPUT_CAP_BYTES,
    runner,
  });
}

export async function supabaseStatus(workdir, options = {}) {
  validateWorkdir(workdir);
  const value = await invoke(['status', '-o', 'json', '--workdir', workdir], STATUS_TIMEOUT_MS, options);
  const data = normalizeStatus(value);
  if (Object.keys(data.services).length === 0) {
    throw new AxiError('provider-invalid-response', 'Supabase returned an incomplete local status');
  }
  return { data, meta: { empty: false } };
}

function normalizedProject(value) {
  const normalized = normalizeProject(value);
  if ((!normalized.ref && !normalized.id) || !normalized.name) {
    throw new AxiError('provider-invalid-response', 'Supabase returned an incomplete project');
  }
  return normalized;
}

export async function projectList(limit = DEFAULT_LIMIT, options = {}) {
  validateLimit(limit);
  const value = await invoke(['projects', 'list', '--output-format', 'json'], PROJECTS_TIMEOUT_MS, options);
  if (!Array.isArray(value)) throw new AxiError('provider-invalid-response', 'Supabase returned a non-list response');
  const items = value.slice(0, limit).map(normalizedProject);
  return {
    data: { items },
    meta: {
      returned: items.length,
      limit,
      truncated: value.length > limit,
      totalKnown: true,
      empty: items.length === 0,
    },
  };
}

export async function supabaseAccessStatus(options = {}) {
  try {
    await projectList(1, options);
    return { data: { available: true, authenticated: true }, meta: { empty: false } };
  } catch (error) {
    if (error.code === 'adapter-unavailable') return { data: { available: false, authenticated: false }, meta: { empty: false } };
    if (error.details?.providerCode === 'LegacyPlatformAuthRequiredError') {
      return { data: { available: true, authenticated: false }, meta: { empty: false } };
    }
    return { data: { available: true, authenticated: false, degraded: true }, meta: { empty: false } };
  }
}
