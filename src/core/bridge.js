import { randomUUID } from 'node:crypto';
import { AxiError, invalid } from './errors.js';
import { runProcess } from './process.js';

export const BRIDGE_VERSION = '0.1';

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_PARAMS = 16;
const MAX_PARAM_LENGTH = 256;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 512_000;

const BRIDGE_ERRORS = new Map([
  ['unauthenticated', { code: 'bridge-unauthenticated', message: 'Bridge host is not authenticated', retryable: false }],
  ['unavailable', { code: 'bridge-unavailable', message: 'Bridge host is unavailable', retryable: true }],
  ['not-found', { code: 'bridge-not-found', message: 'Bridge host reported no such resource', retryable: false }],
  ['invalid-request', { code: 'bridge-invalid-request', message: 'Bridge host rejected the request', retryable: false }],
  ['rate-limited', { code: 'bridge-rate-limited', message: 'Bridge host is rate limiting requests', retryable: true }],
  ['internal', { code: 'bridge-internal-error', message: 'Bridge host failed internally', retryable: true }],
]);

function protocolError(reason) {
  return new AxiError('bridge-protocol-error', 'Bridge host returned a malformed response', {
    retryable: false,
    details: { reason },
  });
}

function assertName(value, field) {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw invalid('invalid-bridge-request', `${field} must be a lowercase dashed identifier`);
  }
}

export function buildRequest({ service, resource, action, params = {}, limit, id = randomUUID() }) {
  assertName(service, 'service');
  assertName(resource, 'resource');
  assertName(action, 'action');
  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) throw invalid('invalid-bridge-request', `params must have at most ${MAX_PARAMS} keys`);
  for (const [key, value] of entries) {
    if (!NAME_PATTERN.test(key)) throw invalid('invalid-bridge-request', 'param keys must be lowercase dashed identifiers');
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw invalid('invalid-bridge-request', 'param values must be scalar');
    }
    if (typeof value === 'string' && value.length > MAX_PARAM_LENGTH) {
      throw invalid('invalid-bridge-request', `param values must be at most ${MAX_PARAM_LENGTH} characters`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw invalid('invalid-bridge-request', 'param values must be finite');
    }
  }
  const request = { bridge: BRIDGE_VERSION, id, service, resource, action };
  if (entries.length) request.params = Object.fromEntries(entries);
  if (limit !== undefined) request.limit = limit;
  return request;
}

export function parseResponse(output, requestId) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw protocolError('invalid-json');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolError('not-an-object');
  if (value.bridge !== BRIDGE_VERSION) {
    throw new AxiError('bridge-version-mismatch', 'Bridge host speaks an unsupported protocol version', {
      retryable: false,
      details: { expected: BRIDGE_VERSION },
    });
  }
  if (value.id !== requestId) throw protocolError('correlation-mismatch');
  if (typeof value.ok !== 'boolean') throw protocolError('missing-ok');
  if (!value.ok) {
    const mapped = BRIDGE_ERRORS.get(value.error?.code);
    if (!mapped) throw protocolError('unknown-error-code');
    throw new AxiError(mapped.code, mapped.message, { retryable: mapped.retryable, details: {} });
  }
  if (!Array.isArray(value.items)) throw protocolError('missing-items');
  if (value.total !== undefined && (!Number.isSafeInteger(value.total) || value.total < 0)) throw protocolError('invalid-total');
  if (value.truncated !== undefined && typeof value.truncated !== 'boolean') throw protocolError('invalid-truncated');
  return { items: value.items, total: value.total, truncated: Boolean(value.truncated) };
}

export async function callBridge({
  file,
  prefixArgs = [],
  service,
  resource,
  action,
  params,
  limit,
  id,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  runner = runProcess,
}) {
  const request = buildRequest({ service, resource, action, params, limit, id });
  const result = await runner(file, [...prefixArgs], { timeoutMs, maxBytes, input: `${JSON.stringify(request)}\n` });
  if (result.code !== 0) {
    throw new AxiError('bridge-unavailable', 'Bridge host exited unsuccessfully', {
      retryable: true,
      details: { service, exitCode: result.code },
    });
  }
  return parseResponse(result.stdout, request.id);
}

export async function describeBridge({ file, prefixArgs, service, ...options }) {
  const { items } = await callBridge({ file, prefixArgs, service, resource: 'bridge', action: 'describe', ...options });
  const capabilities = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw protocolError('invalid-capability');
    const { resource, actions, mutation } = item;
    if (typeof resource !== 'string' || !NAME_PATTERN.test(resource)) throw protocolError('invalid-capability');
    if (!Array.isArray(actions) || actions.length === 0 || !actions.every((name) => typeof name === 'string' && NAME_PATTERN.test(name))) {
      throw protocolError('invalid-capability');
    }
    if (typeof mutation !== 'boolean') throw protocolError('invalid-capability');
    if (mutation) {
      throw new AxiError('bridge-mutation-rejected', 'Bridge host declared a mutating capability', {
        retryable: false,
        details: { service, resource },
      });
    }
    capabilities.push({ resource, actions: [...actions], mutation });
  }
  return capabilities;
}
