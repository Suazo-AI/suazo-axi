import path from 'node:path';
import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runJsonCli, runJsonCliAllowingExitCode, runTextCli } from '../core/cli-provider.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STATUS_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 15_000;
const OUTPUT_CAP_BYTES = 1_000_000;
const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function compactText(value, maxLength = 512) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function invalidResponse(message) {
  return new AxiError('provider-invalid-response', message, {
    retryable: true,
    details: { provider: 'docker' },
  });
}

export function validateDockerLimit(limit = DEFAULT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalid('invalid-limit', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

export function validateContainerId(id) {
  if (typeof id !== 'string' || !CONTAINER_ID_PATTERN.test(id)) {
    throw invalid('invalid-container-id', 'container id must start with a letter or number and use only letters, numbers, dots, underscores, or hyphens');
  }
}

export async function resolveDockerTransport({ resolver = resolveExecutable } = {}) {
  const executable = await resolver('docker');
  if (!executable) throw new AxiError('adapter-unavailable', 'Docker CLI is unavailable');
  return { file: executable, prefixArgs: [], source: 'docker-cli' };
}

export function parseDockerNdjson(output) {
  if (typeof output !== 'string') throw invalidResponse('Docker returned an invalid line-delimited response');
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value;
    } catch {
      throw invalidResponse('Docker returned invalid line-delimited JSON');
    }
  });
}

export function normalizeDockerStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'Server')) {
    throw invalidResponse('Docker returned an incomplete version response');
  }
  const client = value.Client;
  const clientVersion = compactText(client?.Version, 64);
  const context = compactText(client?.Context, 128);
  if (!client || typeof client !== 'object' || Array.isArray(client) || !clientVersion || !context) {
    throw invalidResponse('Docker returned an incomplete version response');
  }
  if (value.Server === null) {
    return {
      available: true,
      daemonRunning: false,
      daemonState: 'stopped',
      clientVersion,
      serverVersion: null,
      context,
    };
  }
  if (!value.Server || typeof value.Server !== 'object' || Array.isArray(value.Server)) {
    throw invalidResponse('Docker returned an incomplete version response');
  }
  const serverVersion = compactText(value.Server.Version, 64);
  if (!serverVersion) throw invalidResponse('Docker returned an incomplete version response');
  return {
    available: true,
    daemonRunning: true,
    daemonState: 'running',
    clientVersion,
    serverVersion,
    context,
  };
}

export function normalizeContainer(value) {
  const normalized = {
    id: compactText(value?.ID, 128)?.slice(0, 12) ?? null,
    name: compactText(value?.Names, 256),
    image: compactText(value?.Image, 512),
    state: compactText(value?.State, 64)?.toLowerCase() ?? null,
    status: compactText(value?.Status, 256),
    createdAt: compactText(value?.CreatedAt, 128),
  };
  if (Object.values(normalized).some((item) => item === null)) {
    throw invalidResponse('Docker returned an incomplete container summary');
  }
  return normalized;
}

export function normalizeContainerInspect(value) {
  const state = compactText(value?.State?.Status, 64)?.toLowerCase() ?? null;
  const restartCount = Number.isInteger(value?.RestartCount) && value.RestartCount >= 0 ? value.RestartCount : null;
  const normalized = {
    id: compactText(value?.Id, 128)?.slice(0, 12) ?? null,
    name: compactText(value?.Name, 256)?.replace(/^\/+/, '') ?? null,
    image: compactText(value?.Config?.Image, 512),
    state,
    status: state,
    createdAt: compactText(value?.Created, 128),
    restartCount,
    health: value?.State?.Health === undefined
      ? null
      : compactText(value.State.Health?.Status, 64)?.toLowerCase() ?? null,
  };
  if (['id', 'name', 'image', 'state', 'status', 'createdAt', 'restartCount'].some((field) => normalized[field] === null)) {
    throw invalidResponse('Docker returned an incomplete container inspection');
  }
  return normalized;
}

export function normalizeImage(value) {
  const normalized = {
    id: compactText(value?.ID, 128),
    repository: compactText(value?.Repository, 512),
    tag: compactText(value?.Tag, 256),
    size: compactText(value?.Size, 128),
    createdAt: compactText(value?.CreatedAt, 128),
  };
  if (Object.values(normalized).some((item) => item === null)) {
    throw invalidResponse('Docker returned an incomplete image summary');
  }
  return normalized;
}

function configFileNames(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const names = values.map((item) => compactText(item, 2_048)).filter(Boolean).map((item) => path.posix.basename(item.replaceAll('\\', '/')));
  return names.length > 0 ? names : null;
}

export function normalizeComposeProject(value) {
  const normalized = {
    name: compactText(value?.Name, 256),
    status: compactText(value?.Status, 256),
    configFiles: configFileNames(value?.ConfigFiles),
  };
  if (!normalized.name || !normalized.status || !normalized.configFiles) {
    throw invalidResponse('Docker returned an incomplete Compose project');
  }
  return normalized;
}

async function transport(options) {
  return (options.transportResolver ?? resolveDockerTransport)();
}

function processOptions(resolved, args, timeoutMs, options) {
  return {
    provider: 'docker',
    file: resolved.file,
    prefixArgs: resolved.prefixArgs,
    args,
    timeoutMs,
    maxBytes: OUTPUT_CAP_BYTES,
    runner: options.runner,
  };
}

function dockerTimeout(error) {
  if (error?.code !== 'provider-timeout') throw error;
  throw new AxiError('docker-timeout', 'Docker daemon did not respond before the timeout', {
    retryable: true,
    details: { provider: 'docker' },
  });
}

async function invokeJson(args, timeoutMs, options = {}) {
  try {
    const resolved = await transport(options);
    return await runJsonCli(processOptions(resolved, args, timeoutMs, options));
  } catch (error) {
    return dockerTimeout(error);
  }
}

async function invokeNdjson(args, options = {}) {
  try {
    const resolved = await transport(options);
    const output = await runTextCli(processOptions(resolved, args, LIST_TIMEOUT_MS, options));
    return parseDockerNdjson(output);
  } catch (error) {
    return dockerTimeout(error);
  }
}

export async function dockerStatus(options = {}) {
  let resolved;
  try {
    resolved = await transport(options);
  } catch (error) {
    if (error?.code !== 'adapter-unavailable') throw error;
    return {
      data: { available: false, daemonRunning: false, daemonState: 'cli-missing', clientVersion: null, serverVersion: null, context: null },
      meta: { empty: false },
    };
  }
  try {
    const value = await runJsonCliAllowingExitCode({
      ...processOptions(resolved, ['version', '--format', 'json'], STATUS_TIMEOUT_MS, options),
      allowedExitCodes: null,
    });
    return { data: normalizeDockerStatus(value), meta: { empty: false } };
  } catch (error) {
    if (error?.code !== 'provider-timeout') throw error;
    return {
      data: { available: true, daemonRunning: false, daemonState: 'unreachable', clientVersion: null, serverVersion: null, context: null },
      meta: { empty: false },
    };
  }
}

function listResult(values, limit, normalize) {
  const items = values.slice(0, limit).map(normalize);
  return {
    data: { items },
    meta: {
      returned: items.length,
      limit,
      truncated: values.length > limit,
      totalKnown: true,
      empty: items.length === 0,
    },
  };
}

export async function containerList({ all = false, limit = DEFAULT_LIMIT } = {}, options = {}) {
  if (typeof all !== 'boolean') throw invalid('invalid-all', 'all must be a boolean');
  validateDockerLimit(limit);
  const args = ['ps'];
  if (all) args.push('--all');
  args.push('--format', 'json');
  const values = await invokeNdjson(args, options);
  return listResult(values, limit, normalizeContainer);
}

export async function containerView(id, options = {}) {
  validateContainerId(id);
  const value = await invokeJson(['inspect', id, '--format', 'json'], LIST_TIMEOUT_MS, options);
  const inspected = Array.isArray(value) && value.length === 1
    ? value[0]
    : value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  if (!inspected) throw invalidResponse('Docker returned an invalid container inspection');
  return { data: normalizeContainerInspect(inspected), meta: { empty: false } };
}

export async function imageList(limit = DEFAULT_LIMIT, options = {}) {
  validateDockerLimit(limit);
  const values = await invokeNdjson(['images', '--format', 'json'], options);
  return listResult(values, limit, normalizeImage);
}

export async function composeList(options = {}) {
  const value = await invokeJson(['compose', 'ls', '--all', '--format', 'json'], LIST_TIMEOUT_MS, options);
  if (!Array.isArray(value)) throw invalidResponse('Docker returned a non-list Compose response');
  const items = value.map(normalizeComposeProject);
  return {
    data: { items },
    meta: { returned: items.length, totalKnown: true, empty: items.length === 0 },
  };
}
