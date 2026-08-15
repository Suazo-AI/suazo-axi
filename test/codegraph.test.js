import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiError } from '../src/core/errors.js';
import { execute } from '../src/cli.js';
import { integrations } from '../src/catalog/integrations.js';
import { doctor } from '../src/adapters/doctor.js';
import { codegraphDeadCode, codegraphStats, codegraphStatus } from '../src/adapters/codegraph.js';

const executable = process.platform === 'win32' ? 'C:\\tools\\cgr.exe' : '/tools/cgr';
const resolver = async (command) => command === 'cgr' ? executable : null;
const missingResolver = async () => null;

const STATUS_BOUNDS = { timeoutMs: 30_000, maxBytes: 64 * 1024 };
const DEAD_CODE_BOUNDS = { timeoutMs: 300_000, maxBytes: 4 * 1024 * 1024 };

// Captured verbatim from cgr 0.0.639 on 2026-08-15, including the wrapped
// `stack:` line. Normalization is tested offline against the real shape.
const STATUS_TEXT = [
  'stack:    running (memgraph=localhost:7687 reachable=True, ',
  'qdrant=127.0.0.1:6333 reachable=True)',
  'compose:  C:\\Users\\Jason\\.cgr\\docker-compose.yaml',
  'syncs:',
  '  - gym-saas__e07c46ea: last sync 2026-08-15T09:40:55.132195+00:00',
  '  - suazo-axi__fee7f76e: last sync 2026-08-15T09:51:24.032654+00:00',
  '',
].join('\n');

const EMPTY_STATUS_TEXT = [
  'stack:    stopped (memgraph=localhost:7687 reachable=False, ',
  'qdrant=127.0.0.1:6333 reachable=False)',
  'syncs:    (no projects synced via cgr yet)',
  '',
].join('\n');

const STATS_TEXT = [
  '    Node Statistics    ',
  '+---------------------+',
  '| Node Type   | Count |',
  '|-------------+-------|',
  '| Folder      | 3,523 |',
  '| Function    | 2,505 |',
  '|-------------+-------|',
  '| Total Nodes | 6,028 |',
  '+---------------------+',
  '    Relationship Statistics    ',
  '| Relationship Type   | Count |',
  '|---------------------+-------|',
  '| CALLS               | 3,014 |',
  '|---------------------+-------|',
  '| Total Relationships | 3,014 |',
  '',
].join('\n');

const DEAD_CODE_JSON = JSON.stringify([
  { label: 'Function', name: 'exists', qualified_name: 'suazo-axi__fee7f76e.src.adapters.notion.exists', start_line: 12, end_line: 14 },
  { label: 'Function', name: 'exists', qualified_name: 'suazo-axi__fee7f76e.src.adapters.vercel.exists', start_line: 46, end_line: 48 },
]);

function recordingRunner(stdout) {
  const calls = [];
  return {
    calls,
    runner: async (file, args, options) => {
      calls.push({ file, args, options });
      return { code: 0, stdout, stderr: '' };
    },
  };
}

test('codegraph status normalizes the wrapped stack line and the synced projects', async () => {
  const call = recordingRunner(STATUS_TEXT);
  const result = await codegraphStatus({ resolver, runner: call.runner });

  assert.deepEqual(call.calls, [{ file: executable, args: ['-q', 'status'], options: STATUS_BOUNDS }]);
  assert.deepEqual(result, {
    data: {
      available: true,
      stackRunning: true,
      memgraphReachable: true,
      qdrantReachable: true,
      projects: [
        { name: 'gym-saas__e07c46ea', lastSync: '2026-08-15T09:40:55.132195+00:00' },
        { name: 'suazo-axi__fee7f76e', lastSync: '2026-08-15T09:51:24.032654+00:00' },
      ],
    },
    meta: { total: 2, empty: false },
  });
});

test('codegraph status reports a definitive empty state when the stack is down', async () => {
  const call = recordingRunner(EMPTY_STATUS_TEXT);
  const result = await codegraphStatus({ resolver, runner: call.runner });

  assert.equal(result.data.stackRunning, false);
  assert.equal(result.data.memgraphReachable, false);
  assert.equal(result.data.qdrantReachable, false);
  assert.deepEqual(result.data.projects, []);
  assert.deepEqual(result.meta, { total: 0, empty: true });
});

test('codegraph status reports an absent CLI without spawning a process', async () => {
  let spawned = false;
  const result = await codegraphStatus({
    resolver: missingResolver,
    runner: async () => { spawned = true; return { code: 0, stdout: 'x', stderr: '' }; },
  });

  assert.equal(spawned, false);
  assert.deepEqual(result, { data: { available: false, stackRunning: false, projects: [] }, meta: { total: 0, empty: true } });
});

test('codegraph stats splits the two tables and drops the header and total rows', async () => {
  const call = recordingRunner(STATS_TEXT);
  const result = await codegraphStats({ resolver, runner: call.runner });

  assert.deepEqual(call.calls, [{ file: executable, args: ['-q', 'stats'], options: STATUS_BOUNDS }]);
  assert.deepEqual(result.data, {
    nodes: { Folder: 3523, Function: 2505 },
    relationships: { CALLS: 3014 },
    totalNodes: 6028,
    totalRelationships: 3014,
  });
  assert.deepEqual(result.meta, { total: 9042, empty: false });
});

test('codegraph dead-code uses exact argv and reports the full total beside the page', async () => {
  const call = recordingRunner(DEAD_CODE_JSON);
  const result = await codegraphDeadCode('suazo-axi__fee7f76e', { limit: 1 }, { resolver, runner: call.runner });

  assert.deepEqual(call.calls, [{
    file: executable,
    args: ['-q', 'dead-code', '-n', 'suazo-axi__fee7f76e', '--format', 'json'],
    options: DEAD_CODE_BOUNDS,
  }]);
  assert.deepEqual(result, {
    data: {
      project: 'suazo-axi__fee7f76e',
      symbols: [{ name: 'exists', qualifiedName: 'suazo-axi__fee7f76e.src.adapters.notion.exists', kind: 'Function', startLine: 12 }],
      truncated: true,
    },
    meta: { total: 2, returned: 1, empty: false },
  });
});

test('codegraph dead-code appends --classes only when asked', async () => {
  const call = recordingRunner('[]');
  const result = await codegraphDeadCode('gym-saas__e07c46ea', { includeClasses: true }, { resolver, runner: call.runner });

  assert.deepEqual(call.calls[0].args, ['-q', 'dead-code', '-n', 'gym-saas__e07c46ea', '--format', 'json', '--classes']);
  assert.deepEqual(result.data.symbols, []);
  assert.deepEqual(result.meta, { total: 0, returned: 0, empty: true });
});

test('codegraph rejects malformed project names and out-of-range limits before spawning', async () => {
  let spawned = false;
  const runner = async () => { spawned = true; return { code: 0, stdout: '[]', stderr: '' }; };

  for (const project of ['', '   ', 'has space', 'semi;colon', 'nul\u0000name']) {
    await assert.rejects(
      () => codegraphDeadCode(project, {}, { resolver, runner }),
      (error) => error instanceof AxiError && error.code === 'invalid-arguments',
    );
  }
  for (const limit of [0, 501, 1.5, Number.NaN]) {
    await assert.rejects(
      () => codegraphDeadCode('ok__deadbeef', { limit }, { resolver, runner }),
      (error) => error instanceof AxiError && error.code === 'invalid-number',
    );
  }
  assert.equal(spawned, false);
});

test('codegraph sanitizes provider failures and never leaks raw provider output', async () => {
  const failures = [
    [async () => ({ code: 2, stdout: 'boom at C:\\secret\\path', stderr: 'trace' }), 'codegraph-error'],
    [async () => ({ code: 0, stdout: '   ', stderr: '' }), 'provider-invalid-response'],
    [async () => { throw new AxiError('provider-timeout', 'raw timeout text'); }, 'provider-timeout'],
    [async () => { throw new AxiError('provider-output-limit', 'raw cap text'); }, 'provider-output-limit'],
    [async () => { throw new AxiError('adapter-unavailable', 'raw spawn text'); }, 'adapter-unavailable'],
  ];

  for (const [runner, code] of failures) {
    await assert.rejects(
      () => codegraphStats({ resolver, runner }),
      (error) => {
        assert.ok(error instanceof AxiError);
        assert.equal(error.code, code);
        assert.equal(error.details.provider, 'cgr');
        assert.doesNotMatch(error.message, /secret|trace|raw /i);
        return true;
      },
    );
  }
});

test('codegraph dead-code rejects output that is not a JSON array', async () => {
  for (const stdout of ['{"not":"an array"}', 'not json at all']) {
    await assert.rejects(
      () => codegraphDeadCode('ok__deadbeef', {}, { resolver, runner: async () => ({ code: 0, stdout, stderr: '' }) }),
      (error) => error instanceof AxiError && error.code === 'provider-invalid-response',
    );
  }
});

test('the CLI dispatches every codegraph command and rejects unknown ones', async () => {
  const codegraph = {
    status: async () => ({ data: { available: true, stackRunning: true, projects: [] }, meta: { total: 0, empty: true } }),
    stats: async () => ({ data: { totalNodes: 1 }, meta: { total: 1, empty: false } }),
    deadCode: async (project, options) => ({ data: { project, options }, meta: { total: 0, empty: true } }),
  };

  for (const [argv, command] of [
    [['codegraph', 'status'], 'codegraph status'],
    [['codegraph', 'stats'], 'codegraph stats'],
    [['codegraph', 'dead-code', '--project', 'gym-saas__e07c46ea', '--limit', '3'], 'codegraph dead-code'],
  ]) {
    const result = await execute([...argv, '--format', 'json'], { codegraph });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(JSON.parse(result.output).command, command);
  }
  assert.deepEqual(
    JSON.parse((await execute(['codegraph', 'dead-code', '--project', 'gym-saas__e07c46ea', '--limit', '3', '--format', 'json'], { codegraph })).output).data,
    { project: 'gym-saas__e07c46ea', options: { limit: 3, includeClasses: false } },
  );

  for (const [argv, code] of [
    [['codegraph', 'nonsense'], 'unknown-command'],
    [['codegraph', 'dead-code'], 'missing-required-flag'],
    [['codegraph', 'dead-code', '--project', 'private project 7391'], 'invalid-arguments'],
    [['codegraph', 'stats', '--project', 'x'], 'invalid-flag'],
  ]) {
    const result = await execute([...argv, '--format', 'json'], { codegraph });
    assert.equal(result.exitCode, 2, result.output);
    assert.equal(JSON.parse(result.output).error.code, code);
    assert.ok(!result.output.includes('private project 7391'), result.output);
  }
});

test('the catalog declares codegraph read-only and doctor separates a stopped daemon from a missing CLI', async () => {
  const entry = integrations.find((item) => item.id === 'codegraph');
  assert.ok(entry, 'codegraph must be listed in the catalog');
  assert.equal(entry.status, 'implemented');
  assert.equal(entry.transport, 'cgr-cli');
  assert.deepEqual(entry.capabilities, [{ resource: 'code-graph', actions: ['status', 'stats', 'dead-code'], mutation: false }]);
  assert.ok(entry.capabilities.every((capability) => capability.mutation === false));

  const cases = [
    [{ available: true, stackRunning: true, memgraphReachable: true }, 'ready'],
    [{ available: true, stackRunning: false, memgraphReachable: false }, 'daemon-stopped'],
    [{ available: true, stackRunning: true, memgraphReachable: false }, 'daemon-stopped'],
    [{ available: false, stackRunning: false }, 'unavailable'],
  ];

  for (const [data, expected] of cases) {
    const report = await doctor({ codegraphProbe: async () => ({ data }) });
    const adapter = report.data.adapters.find((item) => item.id === 'codegraph');
    assert.equal(adapter.status, expected);
  }

  const degraded = await doctor({ codegraphProbe: async () => { throw new Error('probe blew up'); } });
  assert.equal(degraded.data.adapters.find((item) => item.id === 'codegraph').status, 'degraded');
});
