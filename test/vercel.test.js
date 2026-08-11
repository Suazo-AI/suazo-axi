import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiError } from '../src/core/errors.js';
import { runJsonCli } from '../src/core/cli-provider.js';
import {
  deploymentList,
  deploymentView,
  normalizeDeployment,
  resolveVercelTransport,
  vercelStatus,
  validateDeployment,
  validateProject,
} from '../src/adapters/vercel.js';

const transportResolver = async () => ({ file: 'provider-bin', prefixArgs: ['fixed-prefix'] });

test('shared CLI harness preserves fixed argv, timeout, cap, and JSON', async () => {
  let call;
  const runner = async (file, args, options) => {
    call = { file, args, options };
    return { code: 0, stdout: '{"items":[]}', stderr: '' };
  };
  assert.deepEqual(await runJsonCli({ provider: 'demo', file: 'demo-bin', prefixArgs: ['fixed'], args: ['list'], runner }), { items: [] });
  assert.deepEqual(call, { file: 'demo-bin', args: ['fixed', 'list'], options: { timeoutMs: 15_000, maxBytes: 1_000_000 } });
});

test('shared CLI harness redacts provider output and maps invalid JSON', async () => {
  const secret = 'secret-value-7391';
  await assert.rejects(
    () => runJsonCli({ provider: 'demo', file: 'demo', args: ['list'], runner: async () => ({ code: 9, stdout: '', stderr: secret }) }),
    (error) => error.code === 'demo-error' && !JSON.stringify(error).includes(secret) && error.details.exitCode === 9,
  );
  await assert.rejects(
    () => runJsonCli({ provider: 'demo', file: 'demo', args: ['list'], runner: async () => ({ code: 0, stdout: secret, stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response' && !JSON.stringify(error).includes(secret),
  );
});

test('shared CLI harness preserves timeout and output-cap errors', async () => {
  for (const code of ['provider-timeout', 'provider-output-limit']) {
    await assert.rejects(
      () => runJsonCli({ provider: 'demo', file: 'demo', args: [], runner: async () => { throw new AxiError(code, 'bounded'); } }),
      (error) => error.code === code,
    );
  }
});

test('Vercel list uses bounded fixed argv and explicit empty state', async () => {
  let call;
  const runner = async (file, args, options) => {
    call = { file, args, options };
    return { code: 0, stdout: '{"contextName":"team","deployments":[],"pagination":{"next":null}}', stderr: '' };
  };
  const result = await deploymentList(undefined, 7, { transportResolver, runner });
  assert.deepEqual(call.args, ['fixed-prefix', 'list', '--all', '--limit', '7', '--json', '--non-interactive', '--no-color']);
  assert.deepEqual(result.data.items, []);
  assert.deepEqual(result.meta, { returned: 0, limit: 7, truncated: false, totalKnown: false, empty: true });
});

test('Vercel normalization keeps compact deployment fields', async () => {
  const raw = { id: 'dpl_ABC123', name: 'axi', url: 'axi.example.com', state: 'READY', target: 'production', createdAt: 1_700_000_000_000 };
  assert.deepEqual(normalizeDeployment(raw), {
    reference: 'dpl_ABC123', id: 'dpl_ABC123', project: 'axi', url: 'https://axi.example.com', state: 'ready', target: 'production', createdAt: '2023-11-14T22:13:20.000Z',
  });
  const result = await deploymentView('dpl_ABC123', {
    transportResolver,
    runner: async () => ({ code: 0, stdout: JSON.stringify(raw), stderr: '' }),
  });
  assert.equal(result.data.id, 'dpl_ABC123');
});

test('Vercel list URL remains a usable view reference when the provider omits IDs', async () => {
  const raw = { url: 'axi.vercel.app', name: 'axi', state: 'READY', createdAt: 1_700_000_000_000 };
  const result = await deploymentList(undefined, 1, {
    transportResolver,
    runner: async () => ({ code: 0, stdout: JSON.stringify({ deployments: [raw], pagination: { next: null } }), stderr: '' }),
  });
  assert.equal(result.data.items[0].reference, 'axi.vercel.app');
  assert.equal(result.data.items[0].id, null);
});

test('Vercel inputs reject option-shaped and malformed values before invocation', () => {
  assert.doesNotThrow(() => validateProject('valid-project'));
  assert.throws(() => validateProject('-bad'), /project must start/);
  assert.doesNotThrow(() => validateDeployment('dpl_ABC123'));
  assert.doesNotThrow(() => validateDeployment('axi.vercel.app'));
  assert.throws(() => validateDeployment('--token'), /deployment must be/);
});

test('Vercel transport prefers the secure wrapper and safely falls back on Windows', async () => {
  const secure = await resolveVercelTransport({
    platform: 'win32',
    resolver: async (name) => ({ 'vercel-secure': 'C:\\bin\\vercel-secure.cmd', 'powershell.exe': 'C:\\Windows\\powershell.exe' })[name] || null,
    fileExists: async () => true,
  });
  assert.equal(secure.file, 'C:\\Windows\\powershell.exe');
  assert.equal(secure.auth, 'secure-wrapper');
  assert.match(secure.prefixArgs.at(-1), /Invoke-VercelSecure\.ps1$/);

  const fallback = await resolveVercelTransport({
    platform: 'win32',
    resolver: async (name) => name === 'vercel-secure' ? 'C:\\bin\\vercel-secure.cmd' : name === 'vercel' ? 'C:\\npm\\vercel.cmd' : null,
    fileExists: async () => true,
    nodePath: 'C:\\node\\node.exe',
  });
  assert.equal(fallback.file, 'C:\\node\\node.exe');
  assert.deepEqual(fallback.prefixArgs, ['C:\\npm\\node_modules\\vercel\\dist\\vc.js']);
});

test('Vercel transport reports a missing CLI and uses direct executables on POSIX', async () => {
  const direct = await resolveVercelTransport({ platform: 'linux', resolver: async () => '/usr/bin/vercel' });
  assert.deepEqual(direct, { file: '/usr/bin/vercel', prefixArgs: [], auth: 'vercel-cli' });
  await assert.rejects(
    () => resolveVercelTransport({ platform: 'linux', resolver: async () => null }),
    (error) => error.code === 'adapter-unavailable',
  );
});

test('Vercel status distinguishes unavailable, ready, and degraded probes', async () => {
  const ready = await vercelStatus({ transportResolver, runner: async () => ({ code: 0, stdout: '{"username":"user"}', stderr: '' }) });
  assert.deepEqual(ready.data, { available: true, authenticated: true });
  const degraded = await vercelStatus({ transportResolver, runner: async () => ({ code: 0, stdout: 'not-json', stderr: '' }) });
  assert.deepEqual(degraded.data, { available: true, authenticated: false, degraded: true });
  const unavailable = await vercelStatus({ transportResolver: async () => { throw new AxiError('adapter-unavailable', 'missing'); } });
  assert.deepEqual(unavailable.data, { available: false, authenticated: false });
});

test('Vercel rejects valid JSON with incomplete deployment shapes', async () => {
  await assert.rejects(
    () => deploymentList(undefined, 1, { transportResolver, runner: async () => ({ code: 0, stdout: '{"deployments":[{}]}', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => deploymentView('valid.vercel.app', { transportResolver, runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
});
