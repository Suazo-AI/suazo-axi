import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AxiError } from '../src/core/errors.js';
import { BRIDGE_VERSION, buildRequest, callBridge, describeBridge, parseResponse } from '../src/core/bridge.js';

const MOCK = fileURLToPath(new URL('../scripts/bridge-mock.mjs', import.meta.url));

function mock(scenario) {
  return { file: process.execPath, prefixArgs: [MOCK, scenario], service: 'stitch' };
}

test('buildRequest emits the versioned contract and rejects unsafe input', () => {
  const request = buildRequest({ service: 'stitch', resource: 'design', action: 'list', params: { project: 'alpha' }, limit: 5, id: 'req-1' });
  assert.deepEqual(request, { bridge: BRIDGE_VERSION, id: 'req-1', service: 'stitch', resource: 'design', action: 'list', params: { project: 'alpha' }, limit: 5 });
  assert.equal(buildRequest({ service: 'stitch', resource: 'design', action: 'list' }).params, undefined);
  assert.match(buildRequest({ service: 'stitch', resource: 'design', action: 'list' }).id, /^[0-9a-f-]{36}$/);

  for (const bad of [
    { service: 'Stitch', resource: 'design', action: 'list' },
    { service: 'stitch', resource: 'design', action: 'LIST' },
    { service: 'stitch', resource: 'design', action: 'list', params: { Project: 'a' } },
    { service: 'stitch', resource: 'design', action: 'list', params: { project: { nested: true } } },
    { service: 'stitch', resource: 'design', action: 'list', params: { project: 'x'.repeat(257) } },
    { service: 'stitch', resource: 'design', action: 'list', params: { project: Number.POSITIVE_INFINITY } },
    { service: 'stitch', resource: 'design', action: 'list', params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 1])) },
  ]) {
    assert.throws(() => buildRequest(bad), (error) => error instanceof AxiError && error.exitCode === 2);
  }
});

test('callBridge sends one request over stdin and never uses a shell', async () => {
  let call;
  const runner = async (file, args, options) => {
    call = { file, args, options };
    return { code: 0, stdout: JSON.stringify({ bridge: BRIDGE_VERSION, id: 'req-1', ok: true, items: [] }), stderr: '' };
  };
  const result = await callBridge({ file: 'bridge-bin', prefixArgs: ['--serve'], service: 'stitch', resource: 'design', action: 'list', id: 'req-1', runner });
  assert.deepEqual(result, { items: [], total: undefined, truncated: false });
  assert.equal(call.file, 'bridge-bin');
  assert.deepEqual(call.args, ['--serve']);
  assert.equal(call.options.timeoutMs, 20_000);
  assert.equal(call.options.maxBytes, 512_000);
  assert.deepEqual(JSON.parse(call.options.input), { bridge: BRIDGE_VERSION, id: 'req-1', service: 'stitch', resource: 'design', action: 'list' });
});

test('parseResponse rejects every malformed shape', () => {
  const ok = { bridge: BRIDGE_VERSION, id: 'req-1', ok: true, items: [] };
  assert.deepEqual(parseResponse(JSON.stringify({ ...ok, total: 4, truncated: true }), 'req-1'), { items: [], total: 4, truncated: true });

  const cases = [
    ['not json', 'bridge-protocol-error'],
    [JSON.stringify([]), 'bridge-protocol-error'],
    [JSON.stringify({ ...ok, bridge: '9.9' }), 'bridge-version-mismatch'],
    [JSON.stringify({ ...ok, id: 'other' }), 'bridge-protocol-error'],
    [JSON.stringify({ bridge: BRIDGE_VERSION, id: 'req-1' }), 'bridge-protocol-error'],
    [JSON.stringify({ ...ok, items: undefined }), 'bridge-protocol-error'],
    [JSON.stringify({ ...ok, total: -1 }), 'bridge-protocol-error'],
    [JSON.stringify({ ...ok, truncated: 'yes' }), 'bridge-protocol-error'],
    [JSON.stringify({ bridge: BRIDGE_VERSION, id: 'req-1', ok: false, error: { code: 'teapot' } }), 'bridge-protocol-error'],
    [JSON.stringify({ bridge: BRIDGE_VERSION, id: 'req-1', ok: false }), 'bridge-protocol-error'],
  ];
  for (const [output, code] of cases) {
    assert.throws(() => parseResponse(output, 'req-1'), (error) => error.code === code, output);
  }
});

test('parseResponse maps the closed error set and discards host messages', () => {
  const secret = 'secret-value-7391';
  const expected = [
    ['unauthenticated', 'bridge-unauthenticated', false],
    ['unavailable', 'bridge-unavailable', true],
    ['not-found', 'bridge-not-found', false],
    ['invalid-request', 'bridge-invalid-request', false],
    ['rate-limited', 'bridge-rate-limited', true],
    ['internal', 'bridge-internal-error', true],
  ];
  for (const [hostCode, axiCode, retryable] of expected) {
    const output = JSON.stringify({ bridge: BRIDGE_VERSION, id: 'req-1', ok: false, error: { code: hostCode, message: secret } });
    assert.throws(
      () => parseResponse(output, 'req-1'),
      (error) => error.code === axiCode && error.retryable === retryable && !JSON.stringify({ m: error.message, d: error.details }).includes(secret),
    );
  }
});

test('mock bridge answers a real subprocess round trip', async () => {
  const result = await callBridge({ ...mock('ok'), resource: 'design', action: 'list', limit: 1 });
  assert.deepEqual(result, { items: [{ reference: 'design-1', title: 'First' }], total: 2, truncated: true });
});

test('describeBridge returns read-only capabilities and rejects mutating hosts', async () => {
  assert.deepEqual(await describeBridge(mock('ok')), [{ resource: 'design', actions: ['list', 'view'], mutation: false }]);
  await assert.rejects(() => describeBridge(mock('mutating-capability')), (error) => error.code === 'bridge-mutation-rejected');
});

test('describeBridge rejects malformed capability entries', async () => {
  for (const items of [[null], [{ resource: 'Design', actions: ['list'], mutation: false }], [{ resource: 'design', actions: [], mutation: false }], [{ resource: 'design', actions: ['list'] }]]) {
    const runner = async () => ({ code: 0, stdout: JSON.stringify({ bridge: BRIDGE_VERSION, id: 'req-1', ok: true, items }), stderr: '' });
    await assert.rejects(
      () => describeBridge({ file: 'bridge-bin', service: 'stitch', id: 'req-1', runner }),
      (error) => error.code === 'bridge-protocol-error',
    );
  }
});

test('mock bridge failure scenarios map to sanitized AXI errors', async () => {
  const secret = 'secret-value-7391';
  const cases = [
    ['unauthenticated', 'bridge-unauthenticated'],
    ['bad-version', 'bridge-version-mismatch'],
    ['bad-correlation', 'bridge-protocol-error'],
    ['unknown-error-code', 'bridge-protocol-error'],
    ['invalid-json', 'bridge-protocol-error'],
    ['exit-nonzero', 'bridge-unavailable'],
  ];
  for (const [scenario, code] of cases) {
    await assert.rejects(
      () => callBridge({ ...mock(scenario), resource: 'design', action: 'list' }),
      (error) => error.code === code && !JSON.stringify({ m: error.message, d: error.details }).includes(secret),
      scenario,
    );
  }
});

// The bounds themselves belong to the subprocess helper and are covered in
// process.test.js. What matters here is that callBridge passes them through and
// lets the helper's errors surface unchanged rather than reframing them as
// protocol failures. Injected runners keep that assertion free of real
// subprocess termination, which the helper already owns.
test('bridge calls forward the helper bounds and surface its errors unchanged', async () => {
  let options;
  await callBridge({
    file: 'bridge-bin',
    service: 'stitch',
    resource: 'design',
    action: 'list',
    id: 'req-1',
    timeoutMs: 1_234,
    maxBytes: 4_096,
    runner: async (file, args, received) => {
      options = received;
      return { code: 0, stdout: JSON.stringify({ bridge: BRIDGE_VERSION, id: 'req-1', ok: true, items: [] }), stderr: '' };
    },
  });
  assert.equal(options.timeoutMs, 1_234);
  assert.equal(options.maxBytes, 4_096);

  for (const code of ['provider-timeout', 'provider-output-limit']) {
    await assert.rejects(
      () => callBridge({ file: 'bridge-bin', service: 'stitch', resource: 'design', action: 'list', runner: async () => { throw new AxiError(code, 'bounded'); } }),
      (error) => error.code === code,
    );
  }
});
