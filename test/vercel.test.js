import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiError } from '../src/core/errors.js';
import { runJsonCli } from '../src/core/cli-provider.js';
import {
  deploymentList,
  deploymentView,
  normalizeDeployment,
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
