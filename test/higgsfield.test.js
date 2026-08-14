import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AxiError } from '../src/core/errors.js';
import {
  higgsfieldGenerationList,
  higgsfieldGenerationView,
  higgsfieldModelList,
  higgsfieldStatus,
  normalizeGeneration,
  normalizeGenerationList,
  normalizeModelList,
  normalizeStatus,
  resolveHiggsfieldTransport,
  validateJobId,
  validateKind,
  validateLimit,
} from '../src/adapters/higgsfield.js';

const transportResolver = async () => ({ file: 'provider-bin', prefixArgs: ['fixed-prefix'] });
const generation = { id: 'job_123', status: 'completed', model: { id: 'model-1' }, created_at: '2026-08-01T10:00:00Z', output: 'discarded' };

// Captured verbatim from `higgsfield account status --json` against the installed CLI.
// The provider names the plan `subscription_plan_type` and returns `credits` as a plain
// number, so a normalizer that only reads `plan` or `credits.remaining` degrades on every
// real call while still passing invented fixtures.
test('Higgsfield status normalizes the shape the installed CLI actually returns', () => {
  const status = normalizeStatus({ credits: 78, email: 'jason@example.com', subscription_plan_type: 'basic' });
  assert.deepEqual(status, { available: true, authenticated: true, plan: 'basic', creditsRemaining: 78 });
  assert.equal(JSON.stringify(status).includes('@'), false);
});

// Captured verbatim from `higgsfield model list --json` and `higgsfield generate list --json`.
// Models are keyed by job_type/display_name/type and the live catalog serves kinds outside the
// `--kind` filter set, such as `3d`. Generations name the model `job_type`, not `model`.
test('Higgsfield listings normalize the shapes the installed CLI actually returns', () => {
  assert.deepEqual(normalizeModelList([{ display_name: '3D Body', job_type: 'sam_3_3d_body', type: '3d' }]), {
    items: [{ id: 'sam_3_3d_body', name: '3D Body', kind: '3d' }],
  });

  const live = {
    created_at: '2026-08-12T22:41:10.527972Z',
    display_name: 'Nano Banana Pro',
    id: 'b2f5e0d5-f93e-4c8d-a4c0-c288a7da89db',
    job_type: 'nano_banana_pro',
    min_result_url: 'https://cdn.example/secret-asset.webp',
    params: { prompt: 'private prompt text', input_images: [{ url: 'https://cdn.example/private.png' }] },
    result_url: 'https://cdn.example/secret-asset.png',
    status: 'completed',
  };
  const generation = normalizeGeneration(live);
  assert.deepEqual(generation, {
    id: 'b2f5e0d5-f93e-4c8d-a4c0-c288a7da89db',
    status: 'completed',
    model: 'nano_banana_pro',
    createdAt: '2026-08-12T22:41:10.527972Z',
  });
  const serialized = JSON.stringify(generation);
  assert.equal(serialized.includes('cdn.example'), false);
  assert.equal(serialized.includes('private prompt text'), false);
});

test('Higgsfield pure normalizers discard email and provider-specific fields', () => {
  const status = normalizeStatus({ data: { plan: 'pro', remainingCredits: 12, email: 'secret@example.com', token: 'secret' } });
  assert.deepEqual(status, { available: true, authenticated: true, plan: 'pro', creditsRemaining: 12 });
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.deepEqual(normalizeModelList({ models: [{ id: 'model-1', name: 'Flux', type: 'image', price: 4 }] }), {
    items: [{ id: 'model-1', name: 'Flux', kind: 'image' }],
  });
  assert.deepEqual(normalizeGeneration(generation), {
    id: 'job_123', status: 'completed', model: 'model-1', createdAt: '2026-08-01T10:00:00Z',
  });
  assert.deepEqual(normalizeGenerationList({ data: { generations: [generation] } }).items[0], normalizeGeneration(generation));
});

test('Higgsfield model and generation lists use fixed argv, local limits, and explicit empty meta', async () => {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    const stdout = args.includes('model')
      ? '{"items":[{"id":"one","name":"One","kind":"image"},{"id":"two","name":"Two","kind":"image"}]}'
      : '{"generations":[]}';
    return { code: 0, stdout, stderr: '' };
  };
  const models = await higgsfieldModelList('image', 1, { transportResolver, runner });
  assert.deepEqual(calls[0], {
    file: 'provider-bin', args: ['fixed-prefix', 'model', 'list', '--image', '--json'], options: { timeoutMs: 20_000, maxBytes: 512_000 },
  });
  assert.deepEqual(models.meta, { returned: 1, limit: 1, truncated: true, totalKnown: true, empty: false });
  const generations = await higgsfieldGenerationList(10, { transportResolver, runner });
  assert.deepEqual(calls[1].args, ['fixed-prefix', 'generate', 'list', '--json']);
  assert.deepEqual(generations, {
    data: { items: [] }, meta: { returned: 0, limit: 10, truncated: false, totalKnown: true, empty: true },
  });
});

test('Higgsfield generation view uses exact argv and compact output', async () => {
  let call;
  const viewed = await higgsfieldGenerationView('job_123', {
    transportResolver,
    runner: async (file, args, options) => { call = { file, args, options }; return { code: 0, stdout: JSON.stringify(generation), stderr: '' }; },
  });
  assert.deepEqual(call.args, ['fixed-prefix', 'generate', 'get', 'job_123', '--json']);
  assert.deepEqual(viewed.data, normalizeGeneration(generation));
  assert.deepEqual(viewed.meta, { empty: false });
});

test('Higgsfield rejects invalid inputs before invocation', async () => {
  let called = false;
  const options = { transportResolver, runner: async () => { called = true; return { code: 0, stdout: '[]', stderr: '' }; } };
  await assert.rejects(() => higgsfieldModelList('binary', 10, options), (error) => error.code === 'invalid-kind');
  await assert.rejects(() => higgsfieldGenerationView('--token', options), (error) => error.code === 'invalid-generation-id');
  for (const limit of [0, 101, 1.5, '10']) assert.throws(() => validateLimit(limit), /integer from 1 to 100/);
  assert.doesNotThrow(() => validateKind(undefined));
  assert.doesNotThrow(() => validateKind('text'));
  assert.doesNotThrow(() => validateJobId('job-safe_123'));
  assert.equal(called, false);
});

test('Higgsfield rejects incomplete JSON and redacts CLI errors', async () => {
  assert.throws(() => normalizeModelList({ models: [{}] }), (error) => error.code === 'provider-invalid-response');
  assert.throws(() => normalizeGeneration({ id: 'only-id' }), (error) => error.code === 'provider-invalid-response');
  assert.throws(() => normalizeGenerationList({ data: {} }), (error) => error.code === 'provider-invalid-response');
  const secret = 'higgsfield-secret-7391';
  await assert.rejects(
    () => higgsfieldGenerationList(10, { transportResolver, runner: async () => ({ code: 7, stdout: secret, stderr: secret }) }),
    (error) => error.code === 'higgsfield-error' && !JSON.stringify(error).includes(secret),
  );
});

test('Higgsfield transport handles Windows shims, native fallback, direct binaries, and absence', async () => {
  const nodeEntry = path.win32.join('C:\\npm', 'node_modules', '@higgsfield', 'cli', 'bin', 'higgsfield.js');
  assert.deepEqual(await resolveHiggsfieldTransport({
    platform: 'win32', resolver: async () => 'C:\\npm\\higgsfield.cmd', fileExists: async (file) => file === nodeEntry, nodePath: 'node.exe',
  }), { file: 'node.exe', prefixArgs: [nodeEntry], source: 'node-cli' });
  const nativeEntry = path.win32.join('C:\\npm', 'node_modules', '@higgsfield', 'cli', 'vendor', 'hf.exe');
  assert.deepEqual(await resolveHiggsfieldTransport({
    platform: 'win32', resolver: async () => 'C:\\npm\\higgsfield.ps1', fileExists: async (file) => file === nativeEntry,
  }), { file: nativeEntry, prefixArgs: [], source: 'native-cli' });
  assert.deepEqual(await resolveHiggsfieldTransport({ platform: 'win32', resolver: async () => 'C:\\bin\\higgsfield.exe' }), {
    file: 'C:\\bin\\higgsfield.exe', prefixArgs: [], source: 'direct-cli',
  });
  assert.deepEqual(await resolveHiggsfieldTransport({ platform: 'linux', resolver: async () => '/usr/bin/higgsfield' }), {
    file: '/usr/bin/higgsfield', prefixArgs: [], source: 'direct-cli',
  });
  await assert.rejects(() => resolveHiggsfieldTransport({ resolver: async () => null }), (error) => error.code === 'adapter-unavailable');
  await assert.rejects(
    () => resolveHiggsfieldTransport({ platform: 'win32', resolver: async () => 'C:\\npm\\higgsfield.cmd', fileExists: async () => false }),
    (error) => error.code === 'adapter-unavailable',
  );
});

test('Higgsfield status distinguishes authenticated, unavailable, authentication-required, and degraded', async () => {
  const ready = await higgsfieldStatus({ transportResolver, runner: async () => ({ code: 0, stdout: '{"plan":"starter","creditsRemaining":5,"email":"hidden@example.com"}', stderr: '' }) });
  assert.deepEqual(ready.data, { available: true, authenticated: true, plan: 'starter', creditsRemaining: 5 });
  const unavailable = await higgsfieldStatus({ transportResolver: async () => { throw new AxiError('adapter-unavailable', 'missing'); } });
  assert.deepEqual(unavailable.data, { available: false, authenticated: false, plan: null, creditsRemaining: null });
  const auth = await higgsfieldStatus({ transportResolver, runner: async () => ({ code: 1, stdout: '{}', stderr: '' }) });
  assert.deepEqual(auth.data, { available: true, authenticated: false, plan: null, creditsRemaining: null });
  const degraded = await higgsfieldStatus({ transportResolver, runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) });
  assert.deepEqual(degraded.data, { available: true, authenticated: false, plan: null, creditsRemaining: null, degraded: true });
});
