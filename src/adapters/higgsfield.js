import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runJsonCli } from '../core/cli-provider.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const OUTPUT_CAP_BYTES = 512_000;
const KINDS = new Set(['image', 'video', 'audio', 'text']);
const JOB_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function compactText(value, maxLength = 2_048) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > maxLength) return null;
  const normalized = value.trim();
  return normalized || null;
}

export function validateKind(kind) {
  if (kind !== undefined && !KINDS.has(kind)) {
    throw invalid('invalid-kind', 'kind must be image, video, audio, or text');
  }
  return kind;
}

export function validateJobId(id) {
  if (typeof id !== 'string' || id.startsWith('-') || !JOB_PATTERN.test(id)) {
    throw invalid('invalid-generation-id', 'id must use 1 to 128 letters, numbers, underscores, or hyphens');
  }
  return id;
}

export function validateLimit(limit = DEFAULT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalid('invalid-limit', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function listValues(value, key) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || value.success === false) {
    throw new AxiError('provider-invalid-response', 'Higgsfield returned an invalid list response');
  }
  for (const candidate of [value.items, value[key], value.data, value.data?.items, value.data?.[key]]) {
    if (Array.isArray(candidate)) return candidate;
  }
  throw new AxiError('provider-invalid-response', 'Higgsfield returned a non-list response');
}

export function normalizeStatus(value) {
  const source = value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new AxiError('provider-invalid-response', 'Higgsfield returned an invalid status');
  }
  const plan = compactText(source.subscription_plan_type ?? source.plan ?? source.subscription?.plan, 128);
  const creditsRemaining = typeof source.credits === 'number'
    ? source.credits
    : source.creditsRemaining ?? source.remainingCredits ?? source.credits?.remaining;
  if (!plan || typeof creditsRemaining !== 'number' || !Number.isFinite(creditsRemaining) || creditsRemaining < 0) {
    throw new AxiError('provider-invalid-response', 'Higgsfield returned an incomplete status');
  }
  return { available: true, authenticated: true, plan, creditsRemaining };
}

export function normalizeModel(value, fallbackKind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AxiError('provider-invalid-response', 'Higgsfield returned an invalid model');
  }
  const model = {
    id: compactText(value.job_type ?? value.id, 256),
    name: compactText(value.display_name ?? value.name, 256),
    kind: compactText(value.type ?? value.kind ?? value.modality ?? fallbackKind, 32),
  };
  // KINDS is the closed vocabulary of `--kind` filter flags the CLI accepts, not of the kinds it
  // returns: the live catalog also serves `3d` and `data`. Validating output against the input set
  // rejects every listing the moment the provider adds a type, so only the input stays strict.
  if (!model.id || !model.name || !model.kind) {
    throw new AxiError('provider-invalid-response', 'Higgsfield returned an incomplete model');
  }
  return model;
}

export function normalizeModelList(value, kind) {
  return { items: listValues(value, 'models').map((item) => normalizeModel(item, kind)) };
}

export function normalizeGeneration(value) {
  const source = value?.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new AxiError('provider-invalid-response', 'Higgsfield returned an invalid generation');
  }
  const modelValue = source.job_type ?? source.display_name ?? source.model;
  const generation = {
    id: compactText(source.id, 128),
    status: compactText(source.status, 64),
    model: compactText(typeof modelValue === 'object' ? modelValue?.id ?? modelValue?.name : modelValue, 256),
    createdAt: compactText(source.createdAt ?? source.created_at, 128),
  };
  if (!generation.id || !generation.status || !generation.model || !generation.createdAt) {
    throw new AxiError('provider-invalid-response', 'Higgsfield returned an incomplete generation');
  }
  return generation;
}

export function normalizeGenerationList(value) {
  return { items: listValues(value, 'generations').map(normalizeGeneration) };
}

export async function resolveHiggsfieldTransport({
  resolver = resolveExecutable,
  platform = process.platform,
  fileExists = exists,
  nodePath = process.execPath,
} = {}) {
  const executable = await resolver('higgsfield');
  if (!executable) throw new AxiError('adapter-unavailable', 'Higgsfield CLI is unavailable');
  if (platform !== 'win32' || !/\.(?:cmd|bat|ps1)$/i.test(executable)) {
    return { file: executable, prefixArgs: [], source: 'direct-cli' };
  }

  // Windows shim layout, so the joins must be Windows joins on any host: posix dirname of
  // 'C:\\npm\\higgsfield.ps1' is '.', and the resolved entry would never match.
  const base = path.win32.dirname(executable);
  if (/\.ps1$/i.test(executable)) {
    const nativeEntry = path.win32.join(base, 'node_modules', '@higgsfield', 'cli', 'vendor', 'hf.exe');
    if (await fileExists(nativeEntry)) return { file: nativeEntry, prefixArgs: [], source: 'native-cli' };
  }
  const nodeEntry = path.win32.join(base, 'node_modules', '@higgsfield', 'cli', 'bin', 'higgsfield.js');
  if (await fileExists(nodeEntry)) return { file: nodePath, prefixArgs: [nodeEntry], source: 'node-cli' };
  throw new AxiError('adapter-unavailable', 'Higgsfield CLI launcher is unavailable');
}

async function invoke(args, { transportResolver = resolveHiggsfieldTransport, runner } = {}) {
  const transport = await transportResolver();
  return runJsonCli({
    provider: 'higgsfield',
    file: transport.file,
    prefixArgs: transport.prefixArgs,
    args,
    timeoutMs: 20_000,
    maxBytes: OUTPUT_CAP_BYTES,
    runner,
  });
}

export async function higgsfieldStatus(options = {}) {
  try {
    const value = await invoke(['account', 'status', '--json'], options);
    return { data: normalizeStatus(value), meta: { empty: false } };
  } catch (error) {
    const base = { plan: null, creditsRemaining: null };
    if (error.code === 'adapter-unavailable') {
      return { data: { available: false, authenticated: false, ...base }, meta: { empty: false } };
    }
    if (error.code === 'higgsfield-error') {
      return { data: { available: true, authenticated: false, ...base }, meta: { empty: false } };
    }
    return { data: { available: true, authenticated: false, ...base, degraded: true }, meta: { empty: false } };
  }
}

export async function higgsfieldModelList(kind, limit = DEFAULT_LIMIT, options = {}) {
  validateKind(kind);
  validateLimit(limit);
  const args = ['model', 'list'];
  if (kind) args.push(`--${kind}`);
  args.push('--json');
  const normalized = normalizeModelList(await invoke(args, options), kind);
  const items = normalized.items.slice(0, limit);
  return {
    data: { items },
    meta: { returned: items.length, limit, truncated: normalized.items.length > limit, totalKnown: true, empty: items.length === 0 },
  };
}

export async function higgsfieldGenerationList(limit = DEFAULT_LIMIT, options = {}) {
  validateLimit(limit);
  const normalized = normalizeGenerationList(await invoke(['generate', 'list', '--json'], options));
  const items = normalized.items.slice(0, limit);
  return {
    data: { items },
    meta: { returned: items.length, limit, truncated: normalized.items.length > limit, totalKnown: true, empty: items.length === 0 },
  };
}

export async function higgsfieldGenerationView(id, options = {}) {
  validateJobId(id);
  const value = await invoke(['generate', 'get', id, '--json'], options);
  return { data: normalizeGeneration(value), meta: { empty: false } };
}
