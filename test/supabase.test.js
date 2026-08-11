import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AxiError } from '../src/core/errors.js';
import {
  normalizeProject,
  normalizeStatus,
  projectList,
  resolveSupabaseTransport,
  supabaseStatus,
  supabaseAccessStatus,
  validateLimit,
} from '../src/adapters/supabase.js';

const transportResolver = async () => ({ file: 'provider-bin', prefixArgs: ['fixed-prefix'] });

test('Supabase transport prefers the installed local entry and safely falls back to a global executable', async () => {
  let resolverCalled = false;
  const local = await resolveSupabaseTransport({
    localEntry: 'local-supabase.js',
    access: async (file) => { assert.equal(file, 'local-supabase.js'); },
    resolver: async () => { resolverCalled = true; return 'global-supabase'; },
    node: 'node-bin',
  });
  assert.deepEqual(local, { file: 'node-bin', prefixArgs: ['local-supabase.js'], source: 'local-cli' });
  assert.equal(resolverCalled, false);

  const global = await resolveSupabaseTransport({
    localEntry: 'missing.js',
    access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    resolver: async (command) => { assert.equal(command, 'supabase'); return '/usr/bin/supabase'; },
    platform: 'linux',
  });
  assert.deepEqual(global, { file: '/usr/bin/supabase', prefixArgs: [], source: 'global-cli' });

  const globalLauncher = path.join('global-bin', 'supabase.cmd');
  const globalEntry = path.join('global-bin', 'node_modules', 'supabase', 'dist', 'supabase.js');
  const windows = await resolveSupabaseTransport({
    localEntry: 'missing.js',
    access: async (file) => { if (file !== globalEntry) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    resolver: async () => globalLauncher,
    platform: 'win32',
    node: 'node-bin',
  });
  assert.deepEqual(windows, { file: 'node-bin', prefixArgs: [globalEntry], source: 'global-cli' });
});

test('Supabase local status uses fixed bounded argv and an explicit workdir', async () => {
  let call;
  const runner = async (file, args, options) => {
    call = { file, args, options };
    return { code: 0, stdout: '{"API_URL":"http://127.0.0.1:54321"}', stderr: '' };
  };
  const result = await supabaseStatus('C:\\work\\project', { transportResolver, runner });
  assert.deepEqual(call, {
    file: 'provider-bin',
    args: ['fixed-prefix', 'status', '-o', 'json', '--workdir', 'C:\\work\\project'],
    options: { timeoutMs: 20_000, maxBytes: 512_000 },
  });
  assert.deepEqual(result, {
    data: { running: true, services: { api: 'http://127.0.0.1:54321' } },
    meta: { empty: false },
  });
});

test('Supabase status uses a strict whitelist and strips credentials and URL secrets', () => {
  const secret = 'service-role-secret-7391';
  const normalized = normalizeStatus({
    API_URL: `http://user:${secret}@127.0.0.1:54321/?token=${secret}#${secret}`,
    GRAPHQL_URL: 'http://127.0.0.1:54321/graphql/v1',
    DB_URL: `postgresql://postgres:${secret}@127.0.0.1:54322/postgres`,
    SERVICE_ROLE_KEY: secret,
    ANON_KEY: secret,
    JWT_SECRET: secret,
  });
  assert.deepEqual(normalized, {
    running: true,
    services: {
      api: 'http://127.0.0.1:54321',
      graphql: 'http://127.0.0.1:54321',
    },
  });
  assert.equal(JSON.stringify(normalized).includes(secret), false);
});

test('Supabase status rejects invalid workdirs and incomplete provider payloads', async () => {
  let called = false;
  await assert.rejects(() => supabaseStatus('', {
    transportResolver,
    runner: async () => { called = true; return { code: 0, stdout: '{}', stderr: '' }; },
  }), (error) => error.code === 'invalid-workdir');
  assert.equal(called, false);

  await assert.rejects(
    () => supabaseStatus('safe-local-project', { transportResolver, runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
});

test('Supabase projects list uses fixed argv, applies limits, and reports truncation', async () => {
  let call;
  const raw = [
    { id: 'one', ref: 'ref-one', name: 'One', region: 'us-east-1', status: 'ACTIVE_HEALTHY' },
    { id: 'two', ref: 'ref-two', name: 'Two', region: 'eu-west-1', status: 'PAUSED' },
  ];
  const runner = async (file, args, options) => {
    call = { file, args, options };
    return { code: 0, stdout: JSON.stringify(raw), stderr: '' };
  };
  const result = await projectList(1, { transportResolver, runner });
  assert.deepEqual(call, {
    file: 'provider-bin',
    args: ['fixed-prefix', 'projects', 'list', '--output-format', 'json'],
    options: { timeoutMs: 20_000, maxBytes: 512_000 },
  });
  assert.equal(result.data.items.length, 1);
  assert.deepEqual(result.meta, { returned: 1, limit: 1, truncated: true, totalKnown: true, empty: false });
});

test('Supabase project normalization keeps only compact non-secret fields', () => {
  const secret = 'database-secret-7391';
  const normalized = normalizeProject({
    id: 'project-id',
    ref: 'project-ref',
    name: 'Project',
    region: 'us-east-1',
    status: 'ACTIVE_HEALTHY',
    health: 'HEALTHY',
    organization_id: 'org-id',
    organization: { id: 'ignored-org-id', name: 'Org', billing_email: secret },
    database: { host: 'db.example.invalid', password: secret },
    api_keys: { service_role: secret },
  });
  assert.deepEqual(normalized, {
    ref: 'project-ref',
    id: 'project-id',
    name: 'Project',
    region: 'us-east-1',
    status: 'active',
    health: 'healthy',
    organization: { id: 'org-id', name: 'Org' },
  });
  assert.equal(JSON.stringify(normalized).includes(secret), false);
  assert.deepEqual(Object.keys(normalized), ['ref', 'id', 'name', 'region', 'status', 'health', 'organization']);
});

test('Supabase projects list has an explicit empty state and validates limits', async () => {
  const empty = await projectList(10, {
    transportResolver,
    runner: async () => ({ code: 0, stdout: '[]', stderr: '' }),
  });
  assert.deepEqual(empty, {
    data: { items: [] },
    meta: { returned: 0, limit: 10, truncated: false, totalKnown: true, empty: true },
  });
  for (const limit of [0, 101, 1.5, '10']) assert.throws(() => validateLimit(limit), /integer from 1 to 100/);
});

test('Supabase errors never include raw provider output', async () => {
  const secret = 'raw-provider-secret-7391';
  for (const result of [
    { code: 1, stdout: secret, stderr: secret },
    { code: 0, stdout: secret, stderr: '' },
  ]) {
    await assert.rejects(
      () => projectList(10, { transportResolver, runner: async () => result }),
      (error) => {
        assert.equal(JSON.stringify(error).includes(secret), false);
        return error.code === 'supabase-error' || error.code === 'provider-invalid-response';
      },
    );
  }
});

test('Supabase preserves bounded transport errors and rejects non-list payloads without raw data', async () => {
  for (const code of ['provider-timeout', 'provider-output-limit']) {
    await assert.rejects(
      () => projectList(10, { transportResolver, runner: async () => { throw new AxiError(code, 'bounded'); } }),
      (error) => error.code === code,
    );
  }
  await assert.rejects(
    () => projectList(10, {
      transportResolver,
      runner: async () => ({ code: 0, stdout: '{"projects":[]}', stderr: '' }),
    }),
    (error) => error.code === 'provider-invalid-response' && error.message === 'Supabase returned a non-list response',
  );
});

test('Supabase rejects incomplete project items', async () => {
  await assert.rejects(
    () => projectList(10, { transportResolver, runner: async () => ({ code: 0, stdout: '[{}]', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
});

test('Supabase auth probe distinguishes login required from degraded failures', async () => {
  const authRequired = await supabaseAccessStatus({
    transportResolver,
    runner: async () => ({ code: 1, stdout: '{"error":{"code":"LegacyPlatformAuthRequiredError","message":"redacted"}}', stderr: '' }),
  });
  assert.deepEqual(authRequired.data, { available: true, authenticated: false });
  const degraded = await supabaseAccessStatus({
    transportResolver,
    runner: async () => ({ code: 1, stdout: '{"error":{"code":"NetworkFailure","message":"redacted"}}', stderr: '' }),
  });
  assert.deepEqual(degraded.data, { available: true, authenticated: false, degraded: true });
});
