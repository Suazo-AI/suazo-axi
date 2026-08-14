import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiError } from '../src/core/errors.js';
import { runJsonCliAllowingExitCode } from '../src/core/cli-provider.js';
import { doctor } from '../src/adapters/doctor.js';
import { execute } from '../src/cli.js';
import {
  composeList,
  containerList,
  containerView,
  dockerStatus,
  imageList,
  normalizeComposeProject,
  normalizeContainer,
  normalizeContainerInspect,
  normalizeDockerStatus,
  normalizeImage,
  parseDockerNdjson,
  resolveDockerTransport,
  validateContainerId,
  validateDockerLimit,
} from '../src/adapters/docker.js';

const transportResolver = async () => ({ file: 'docker-bin', prefixArgs: [] });

// Captured from `docker version --format json` on this machine with Docker Desktop stopped (provided verified capture).
const STOPPED_VERSION = '{"Client":{"Version":"29.6.2","ApiVersion":"1.55","Os":"windows","Arch":"amd64","Context":"desktop-linux"},"Server":null}';

// Captured from `docker ps --format json` in the official Docker CLI command reference; local recapture was blocked by the unreachable daemon.
const CONTAINER_ONE = '{"Command":"\\\"/docker-entrypoint.\\u2026\\\"","CreatedAt":"2021-03-10 00:15:05 +0100 CET","ID":"a762a2b37a1d","Image":"nginx","Labels":"maintainer=NGINX Docker Maintainers \\u003cdocker-maint@nginx.com\\u003e","LocalVolumes":"0","Mounts":"","Names":"boring_keldysh","Networks":"bridge","Ports":"80/tcp","RunningFor":"4 seconds ago","Size":"0B","State":"running","Status":"Up 3 seconds"}';

// Captured from `docker images --format json` in the official Docker CLI command reference; local recapture was blocked by the unreachable daemon.
const IMAGE_ONE = '{"Containers":"N/A","CreatedAt":"2021-03-04 03:24:42 +0100 CET","CreatedSince":"5 days ago","Digest":"\\u003cnone\\u003e","ID":"4dd97cefde62","Repository":"ubuntu","SharedSize":"N/A","Size":"72.9MB","Tag":"latest","UniqueSize":"N/A"}';

// `docker compose ls --all --format json`; local recapture was blocked by the unreachable daemon, so these exact provider keys remain locally unverified.
const COMPOSE_LIST = '[{"Name":"axi","Status":"running(2)","ConfigFiles":"C:\\\\work\\\\axi\\\\compose.yaml,C:\\\\work\\\\axi\\\\compose.override.yaml"}]';

// `docker inspect <id> --format json`; no container ID was obtainable while the daemon was unreachable, so these exact provider keys remain locally unverified.
const INSPECT = {
  Id: '1234567890abcdef1234567890abcdef',
  Created: '2026-08-10T12:30:00.123456789Z',
  Name: '/axi-api',
  RestartCount: 2,
  Config: {
    Image: 'example/api:latest',
    Env: ['SECRET_TOKEN=do-not-leak-7391'],
    Cmd: ['node', 'server.js'],
    Entrypoint: ['/entrypoint.sh'],
    Labels: { token: 'do-not-leak-7391' },
  },
  State: { Status: 'running', Health: { Status: 'healthy', Log: [{ Output: 'do-not-leak-7391' }] } },
  Mounts: [{ Source: 'C:\\Users\\secret', Destination: '/data' }],
};

test('shared CLI harness parses JSON for explicitly allowed nonzero exit codes', async () => {
  const value = await runJsonCliAllowingExitCode({
    provider: 'docker', file: 'docker', args: ['version'], allowedExitCodes: [0, 1],
    runner: async () => ({ code: 1, stdout: STOPPED_VERSION, stderr: 'daemon stopped' }),
  });
  assert.equal(value.Server, null);
  await assert.rejects(
    () => runJsonCliAllowingExitCode({ provider: 'docker', file: 'docker', args: [], allowedExitCodes: [0], runner: async () => ({ code: 1, stdout: STOPPED_VERSION, stderr: '' }) }),
    (error) => error.code === 'docker-error' && error.details.exitCode === 1,
  );
});

test('Docker status accepts stopped exit 1 and normalizes running and missing CLI states', async () => {
  const stopped = await dockerStatus({
    transportResolver,
    runner: async (file, args, options) => {
      assert.equal(file, 'docker-bin');
      assert.deepEqual(args, ['version', '--format', 'json']);
      assert.deepEqual(options, { timeoutMs: 10_000, maxBytes: 1_000_000 });
      return { code: 1, stdout: STOPPED_VERSION, stderr: 'daemon stopped' };
    },
  });
  assert.deepEqual(stopped.data, {
    available: true, daemonRunning: false, daemonState: 'stopped', clientVersion: '29.6.2', serverVersion: null, context: 'desktop-linux',
  });

  // `docker version --format json`; Server shape could not be locally recaptured while the daemon was unreachable.
  const runningRaw = { Client: { Version: '29.6.2', Context: 'desktop-linux' }, Server: { Version: '29.6.2' } };
  assert.deepEqual(normalizeDockerStatus(runningRaw), {
    available: true, daemonRunning: true, daemonState: 'running', clientVersion: '29.6.2', serverVersion: '29.6.2', context: 'desktop-linux',
  });

  const missing = await dockerStatus({ transportResolver: async () => { throw new AxiError('adapter-unavailable', 'missing'); } });
  assert.deepEqual(missing.data, {
    available: false, daemonRunning: false, daemonState: 'cli-missing', clientVersion: null, serverVersion: null, context: null,
  });
});

test('Docker status reports a timed-out daemon as unreachable success', async () => {
  const result = await dockerStatus({
    transportResolver,
    runner: async () => { throw new AxiError('provider-timeout', 'bounded', { retryable: true }); },
  });
  assert.deepEqual(result, {
    data: { available: true, daemonRunning: false, daemonState: 'unreachable', clientVersion: null, serverVersion: null, context: null },
    meta: { empty: false },
  });
});

test('Docker container list parses real-format NDJSON, truncates IDs, and uses fixed bounded argv', async () => {
  let call;
  const result = await containerList({ all: true, limit: 1 }, {
    transportResolver,
    runner: async (file, args, options) => {
      call = { file, args, options };
      return { code: 0, stdout: `${CONTAINER_ONE}\n${CONTAINER_ONE}\n`, stderr: '' };
    },
  });
  assert.deepEqual(call, {
    file: 'docker-bin', args: ['ps', '--all', '--format', 'json'], options: { timeoutMs: 15_000, maxBytes: 1_000_000 },
  });
  assert.deepEqual(result.data.items, [{
    id: 'a762a2b37a1d', name: 'boring_keldysh', image: 'nginx', state: 'running', status: 'Up 3 seconds', createdAt: '2021-03-10 00:15:05 +0100 CET',
  }]);
  assert.deepEqual(result.meta, { returned: 1, limit: 1, truncated: true, totalKnown: true, empty: false });
});

test('Docker NDJSON parser handles one line, blank output, whitespace, and corruption', async () => {
  assert.deepEqual(parseDockerNdjson(`  ${CONTAINER_ONE}  \r\n\r\n`), [JSON.parse(CONTAINER_ONE)]);
  assert.deepEqual(parseDockerNdjson('  \r\n  '), []);
  assert.throws(() => parseDockerNdjson(`${CONTAINER_ONE}\n{broken`), (error) => error.code === 'provider-invalid-response');

  const empty = await containerList(undefined, {
    transportResolver,
    runner: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.deepEqual(empty, {
    data: { items: [] },
    meta: { returned: 0, limit: 20, truncated: false, totalKnown: true, empty: true },
  });
});

test('Docker container view emits only its whitelist and cannot leak inspect secrets or host paths', async () => {
  let call;
  const result = await containerView('1234567890abcdef', {
    transportResolver,
    runner: async (file, args, options) => {
      call = { file, args, options };
      return { code: 0, stdout: JSON.stringify(INSPECT), stderr: '' };
    },
  });
  assert.deepEqual(call, {
    file: 'docker-bin', args: ['inspect', '1234567890abcdef', '--format', 'json'], options: { timeoutMs: 15_000, maxBytes: 1_000_000 },
  });
  assert.deepEqual(result.data, {
    id: '1234567890ab', name: 'axi-api', image: 'example/api:latest', state: 'running', status: 'running',
    createdAt: '2026-08-10T12:30:00.123456789Z', restartCount: 2, health: 'healthy',
  });
  assert.deepEqual(Object.keys(normalizeContainerInspect(INSPECT)), ['id', 'name', 'image', 'state', 'status', 'createdAt', 'restartCount', 'health']);
  const serialized = JSON.stringify(result);
  for (const secret of ['do-not-leak-7391', 'SECRET_TOKEN', 'server.js', 'entrypoint.sh', 'C:\\Users\\secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('Docker image list normalizes real-format NDJSON and exposes an empty definitive state', async () => {
  const result = await imageList(5, {
    transportResolver,
    runner: async (file, args, options) => {
      assert.deepEqual({ file, args, options }, {
        file: 'docker-bin', args: ['images', '--format', 'json'], options: { timeoutMs: 15_000, maxBytes: 1_000_000 },
      });
      return { code: 0, stdout: IMAGE_ONE, stderr: '' };
    },
  });
  assert.deepEqual(result.data.items, [{ id: '4dd97cefde62', repository: 'ubuntu', tag: 'latest', size: '72.9MB', createdAt: '2021-03-04 03:24:42 +0100 CET' }]);
  assert.deepEqual(normalizeImage(JSON.parse(IMAGE_ONE)), result.data.items[0]);

  const empty = await imageList(5, { transportResolver, runner: async () => ({ code: 0, stdout: '\n', stderr: '' }) });
  assert.equal(empty.meta.empty, true);
});

test('Docker Compose list strips host directories from config files', async () => {
  const result = await composeList({
    transportResolver,
    runner: async (file, args, options) => {
      assert.deepEqual({ file, args, options }, {
        file: 'docker-bin', args: ['compose', 'ls', '--all', '--format', 'json'], options: { timeoutMs: 15_000, maxBytes: 1_000_000 },
      });
      return { code: 0, stdout: COMPOSE_LIST, stderr: '' };
    },
  });
  assert.deepEqual(result, {
    data: { items: [{ name: 'axi', status: 'running(2)', configFiles: ['compose.yaml', 'compose.override.yaml'] }] },
    meta: { returned: 1, totalKnown: true, empty: false },
  });
  assert.deepEqual(normalizeComposeProject(JSON.parse(COMPOSE_LIST)[0]), result.data.items[0]);
  assert.equal(JSON.stringify(result).includes('C:'), false);
});

test('Docker rejects invalid input before resolving transport or invoking a runner', async () => {
  let called = false;
  const options = {
    transportResolver: async () => { called = true; return { file: 'docker' }; },
    runner: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; },
  };
  for (const limit of [0, 101, 1.5, '5']) {
    await assert.rejects(() => imageList(limit, options), (error) => error.code === 'invalid-limit');
  }
  await assert.rejects(() => containerList({ all: 'yes', limit: 5 }, options), (error) => error.code === 'invalid-all');
  for (const id of ['', '--all', 'bad/id', 'x'.repeat(129)]) {
    await assert.rejects(() => containerView(id, options), (error) => error.code === 'invalid-container-id');
  }
  assert.equal(called, false);
  assert.doesNotThrow(() => validateDockerLimit(100));
  assert.doesNotThrow(() => validateContainerId('abc_123.def-456'));
});

test('Docker maps listing failures, timeouts, missing CLI, and incomplete JSON honestly', async () => {
  await assert.rejects(
    () => imageList(5, { transportResolver, runner: async () => ({ code: 7, stdout: 'provider secret', stderr: 'provider secret' }) }),
    (error) => error.code === 'docker-error' && error.retryable && !JSON.stringify(error).includes('provider secret'),
  );
  await assert.rejects(
    () => containerList(undefined, { transportResolver, runner: async () => { throw new AxiError('provider-timeout', 'bounded'); } }),
    (error) => error.code === 'docker-timeout' && error.retryable,
  );
  await assert.rejects(
    () => composeList({ transportResolver: async () => { throw new AxiError('adapter-unavailable', 'missing'); } }),
    (error) => error.code === 'adapter-unavailable',
  );
  await assert.rejects(
    () => dockerStatus({ transportResolver, runner: async () => ({ code: 0, stdout: '{"Client":{},"Server":null}', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => dockerStatus({ transportResolver, runner: async () => ({ code: 0, stdout: 'not-json', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => composeList({ transportResolver, runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
});

test('Docker transport resolves only the native docker executable', async () => {
  const direct = await resolveDockerTransport({ resolver: async (command) => {
    assert.equal(command, 'docker');
    return 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
  } });
  assert.deepEqual(direct, {
    file: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', prefixArgs: [], source: 'docker-cli',
  });
  await assert.rejects(() => resolveDockerTransport({ resolver: async () => null }), (error) => error.code === 'adapter-unavailable');
});

test('doctor maps Docker running, stopped, unreachable, and missing states honestly', async () => {
  const common = {
    githubProbe: async () => ({ data: { available: true, authenticated: true } }),
    vercelProbe: async () => ({ data: { available: true, authenticated: true } }),
    supabaseProbe: async () => ({ data: { available: true, authenticated: true } }),
    codexProbe: async () => ({ data: { available: true, authenticated: true } }),
    knowledgeProbe: async () => ({ data: { available: true } }),
    notionProbe: async () => ({ data: { available: true, authenticated: true } }),
    firecrawlProbe: async () => ({ data: { available: true, authenticated: true } }),
    higgsfieldProbe: async () => ({ data: { available: true, authenticated: true } }),
    resolver: async () => null,
  };
  for (const [daemonState, available, expected] of [
    ['running', true, 'ready'],
    ['stopped', true, 'daemon-stopped'],
    ['unreachable', true, 'degraded'],
    ['cli-missing', false, 'unavailable'],
  ]) {
    const result = await doctor({
      ...common,
      dockerProbe: async () => ({ data: { available, daemonRunning: daemonState === 'running', daemonState } }),
    });
    assert.equal(result.data.adapters.find((item) => item.id === 'docker').status, expected);
  }
});

test('Docker CLI dispatcher exposes only named read-only routes with stable labels', async () => {
  const calls = [];
  const docker = {
    status: async () => ({ data: { available: true, daemonRunning: true, daemonState: 'running' }, meta: { empty: false } }),
    containerList: async (...args) => { calls.push(['containerList', ...args]); return { data: { items: [] }, meta: { empty: true } }; },
    containerView: async (...args) => { calls.push(['containerView', ...args]); return { data: { id: args[0] }, meta: { empty: false } }; },
    imageList: async (...args) => { calls.push(['imageList', ...args]); return { data: { items: [] }, meta: { empty: true } }; },
    composeList: async (...args) => { calls.push(['composeList', ...args]); return { data: { items: [] }, meta: { empty: true } }; },
  };
  const cases = [
    [['docker', 'status'], 'docker status'],
    [['docker', 'container', 'list', '--all', '--limit', '5'], 'docker container list'],
    [['docker', 'container', 'view', '--id', 'abc123'], 'docker container view'],
    [['docker', 'image', 'list', '--limit', '6'], 'docker image list'],
    [['docker', 'compose', 'list'], 'docker compose list'],
  ];
  for (const [argv, command] of cases) {
    const result = await execute([...argv, '--format', 'json'], { docker });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.output).command, command);
  }
  assert.deepEqual(calls, [
    ['containerList', { all: true, limit: 5 }],
    ['containerView', 'abc123'],
    ['imageList', 6],
    ['composeList'],
  ]);

  for (const forbidden of ['run', 'exec', 'start', 'stop', 'restart', 'build', 'pull', 'compose up']) {
    const argv = forbidden.split(' ');
    const result = await execute(['docker', ...argv, '--format', 'json'], { docker });
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.output).error.code, 'unknown-command');
  }
});
