import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AxiError } from '../src/core/errors.js';
import { execute } from '../src/cli.js';
import { integrations } from '../src/catalog/integrations.js';
import { doctor } from '../src/adapters/doctor.js';
import {
  knowledgeAffected,
  knowledgePath,
  knowledgeQuery,
  knowledgeStatus,
} from '../src/adapters/knowledge.js';

const executable = process.platform === 'win32' ? 'C:\\tools\\graphify.exe' : '/tools/graphify';
const resolver = async (command) => command === 'graphify' ? executable : null;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-knowledge-'));
  const defaultDir = path.join(root, 'graphify-out');
  const defaultGraph = path.join(defaultDir, 'graph.json');
  await fs.mkdir(defaultDir);
  await fs.writeFile(defaultGraph, '{}');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, defaultGraph };
}

function successfulRunner(stdout = ' traversal output \r\n') {
  const calls = [];
  return {
    calls,
    runner: async (file, args, options) => {
      calls.push({ file, args, options });
      return { code: 0, stdout, stderr: '' };
    },
  };
}

test('knowledge traversal operations use exact argv, resolved graphs, and fixed process bounds', async (t) => {
  const { root, defaultGraph } = await fixture(t);
  const explicitGraph = path.join(root, 'explicit graph.json');
  await fs.writeFile(explicitGraph, '{}');
  const call = successfulRunner();

  const query = await knowledgeQuery('who calls build?', { cwd: root }, { resolver, runner: call.runner });
  const route = await knowledgePath('Start Node', 'End Node', { cwd: root, graph: explicitGraph }, { resolver, runner: call.runner });
  const affected = await knowledgeAffected('Core Node', { cwd: root, graph: explicitGraph, depth: 4 }, { resolver, runner: call.runner });

  assert.deepEqual(call.calls, [
    { file: executable, args: ['query', 'who calls build?', '--budget', '300', '--graph', await fs.realpath(defaultGraph)], options: { timeoutMs: 30_000, maxBytes: 256 * 1024 } },
    { file: executable, args: ['path', 'Start Node', 'End Node', '--graph', await fs.realpath(explicitGraph)], options: { timeoutMs: 30_000, maxBytes: 256 * 1024 } },
    { file: executable, args: ['affected', 'Core Node', '--depth', '4', '--graph', await fs.realpath(explicitGraph)], options: { timeoutMs: 30_000, maxBytes: 256 * 1024 } },
  ]);
  for (const result of [query, route, affected]) {
    assert.deepEqual(result, { data: { text: 'traversal output' }, meta: { characters: 16, empty: false } });
  }
});

test('knowledge inputs and integer bounds reject missing, blank, and NUL values before invocation', async (t) => {
  const { root } = await fixture(t);
  const call = successfulRunner();
  const options = { resolver, runner: call.runner };
  for (const action of [
    () => knowledgeQuery('', { cwd: root }, options),
    () => knowledgeQuery('   ', { cwd: root }, options),
    () => knowledgeQuery('bad\0question', { cwd: root }, options),
    () => knowledgeQuery('q', { cwd: root, budget: 49 }, options),
    () => knowledgeQuery('q', { cwd: root, budget: 2001 }, options),
    () => knowledgeQuery('q', { cwd: root, budget: 50.5 }, options),
    () => knowledgePath('', 'to', { cwd: root }, options),
    () => knowledgePath('from', '\0', { cwd: root }, options),
    () => knowledgeAffected('', { cwd: root }, options),
    () => knowledgeAffected('node', { cwd: root, depth: 0 }, options),
    () => knowledgeAffected('node', { cwd: root, depth: 7 }, options),
    () => knowledgeAffected('node', { cwd: root, depth: 1.5 }, options),
  ]) await assert.rejects(action, (error) => error.exitCode === 2);
  assert.equal(call.calls.length, 0);
});

test('knowledge passes content as individual argv without shell interpolation', async (t) => {
  const { root } = await fixture(t);
  const question = '$(touch owned); & echo %TOKEN% `whoami`';
  const call = successfulRunner('ok');
  await knowledgeQuery(question, { cwd: root, budget: 50 }, { resolver, runner: call.runner });
  assert.equal(call.calls[0].args[1], question);
  assert.equal(call.calls[0].file, executable);
  assert.deepEqual(call.calls[0].options, { timeoutMs: 30_000, maxBytes: 256 * 1024 });
});

test('knowledge redacts resolved graph paths case-insensitively from provider text', async (t) => {
  const { root, defaultGraph } = await fixture(t);
  const resolvedGraph = await fs.realpath(defaultGraph);
  const echoedPath = process.platform === 'win32' ? resolvedGraph.toUpperCase() : resolvedGraph;
  const fileUrl = pathToFileURL(resolvedGraph).href;
  const jsonEscaped = JSON.stringify(resolvedGraph).slice(1, -1);
  const longPath = process.platform === 'win32' ? `\\\\?\\${resolvedGraph}` : resolvedGraph;
  const result = await knowledgeQuery('question', { cwd: root }, {
    resolver,
    runner: async () => ({ code: 0, stdout: `result from ${echoedPath} | ${fileUrl} | ${jsonEscaped} | ${longPath}\n`, stderr: '' }),
  });
  assert.deepEqual(result.data, { text: 'result from [graph] | [graph] | [graph] | [graph]' });
  assert.equal(result.meta.characters, result.data.text.length);
  assert.ok(!JSON.stringify(result).toLowerCase().includes(resolvedGraph.toLowerCase()));
});

test('knowledge requires the selected graph to resolve to a regular file', async (t) => {
  const { root } = await fixture(t);
  const missing = path.join(root, 'private-missing-graph.json');
  const directory = path.join(root, 'graph-directory');
  await fs.mkdir(directory);
  const call = successfulRunner();
  for (const graph of [missing, directory]) {
    await assert.rejects(
      () => knowledgeQuery('question', { cwd: root, graph }, { resolver, runner: call.runner }),
      (error) => error.exitCode === 2 && !JSON.stringify(error).includes(graph),
    );
  }
  assert.equal(call.calls.length, 0);
});

test('knowledge rejects empty successful output and sanitizes every provider failure', async (t) => {
  const { root, defaultGraph } = await fixture(t);
  const secret = 'raw-provider-secret-7391';
  const cases = [
    { runner: successfulRunner(' \r\n ').runner, code: 'provider-invalid-response' },
    { resolver: async () => null, code: 'adapter-unavailable' },
    { resolver: async () => { throw new Error(`${secret} ${defaultGraph}`); }, code: 'adapter-unavailable' },
    { runner: async () => { throw new AxiError('adapter-unavailable', `${secret} ${defaultGraph}`); }, code: 'adapter-unavailable' },
    { runner: async () => { throw new AxiError('provider-timeout', `${secret} ${defaultGraph}`); }, code: 'provider-timeout' },
    { runner: async () => { throw new AxiError('provider-output-limit', `${secret} ${defaultGraph}`); }, code: 'provider-output-limit' },
    { runner: async () => { throw new Error(`${secret} ${defaultGraph}`); }, code: 'graphify-error' },
    { runner: async () => ({ code: 9, stdout: secret, stderr: `${secret} ${defaultGraph}` }), code: 'graphify-error' },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => knowledgeQuery('safe question', { cwd: root }, { resolver: item.resolver || resolver, runner: item.runner }),
      (error) => error.code === item.code
        && error.details.provider === 'graphify'
        && !JSON.stringify(error).includes(secret)
        && !JSON.stringify(error).includes(defaultGraph),
    );
  }
});

test('knowledge status probes version with status bounds and tolerates missing graphs', async (t) => {
  const { root, defaultGraph } = await fixture(t);
  const present = successfulRunner('graphify 1.2.3\n');
  const result = await knowledgeStatus(undefined, { cwd: root, resolver, runner: present.runner });
  assert.deepEqual(present.calls, [{ file: executable, args: ['--version'], options: { timeoutMs: 10_000, maxBytes: 64 * 1024 } }]);
  assert.deepEqual(result, { data: { available: true, version: '1.2.3', graphExists: true }, meta: { empty: false } });

  await fs.rm(defaultGraph);
  const missing = await knowledgeStatus(undefined, { cwd: root, resolver, runner: successfulRunner('Graphify version 2.0.0').runner });
  assert.deepEqual(missing.data, { available: true, version: '2.0.0', graphExists: false });

  const unavailable = await knowledgeStatus('selected.json', { cwd: root, resolver: async () => null, runner: async () => assert.fail('must not run') });
  assert.deepEqual(unavailable.data, { available: false, graphExists: false });

  await assert.rejects(
    () => knowledgeStatus(undefined, { cwd: root, resolver: async () => { throw new Error(defaultGraph); } }),
    (error) => error.code === 'adapter-unavailable' && !JSON.stringify(error).includes(defaultGraph),
  );
});

test('catalog and doctor expose an implemented read-only Graphify adapter', async () => {
  assert.deepEqual(integrations.find((item) => item.id === 'knowledge'), {
    id: 'knowledge',
    domain: 'knowledge',
    transport: 'graphify-cli',
    phase: 5,
    status: 'implemented',
    capabilities: [{ resource: 'knowledge-graph', actions: ['status', 'query', 'path', 'affected'], mutation: false }],
  });

  const common = {
    githubProbe: async () => ({ data: { available: true, authenticated: true } }),
    vercelProbe: async () => ({ data: { available: true, authenticated: true } }),
    supabaseProbe: async () => ({ data: { available: true, authenticated: true } }),
    codexProbe: async () => ({ data: { available: true, authenticated: true } }),
    notionProbe: async () => ({ data: { available: true, authenticated: true } }),
    firecrawlProbe: async () => ({ data: { available: true, authenticated: true } }),
    higgsfieldProbe: async () => ({ data: { available: true, authenticated: true } }),
    dockerProbe: async () => ({ data: { available: true, daemonRunning: true, daemonState: 'running' } }),
    resolver: async () => null,
  };
  const ready = await doctor({ ...common, knowledgeProbe: async () => ({ data: { available: true, graphExists: false } }) });
  const unavailable = await doctor({ ...common, knowledgeProbe: async () => ({ data: { available: false, graphExists: false } }) });
  const degraded = await doctor({ ...common, knowledgeProbe: async () => { throw new Error('safe failure'); } });
  assert.equal(ready.data.adapters.find((item) => item.id === 'knowledge').status, 'ready');
  assert.equal(unavailable.data.adapters.find((item) => item.id === 'knowledge').status, 'unavailable');
  assert.equal(degraded.data.adapters.find((item) => item.id === 'knowledge').status, 'degraded');
});

test('CLI routes frozen knowledge commands with defaults and stable labels', async () => {
  const calls = [];
  const knowledge = {
    status: async (graph) => { calls.push(['status', graph]); return { data: { available: true, graphExists: false }, meta: { empty: false } }; },
    query: async (...args) => { calls.push(['query', ...args]); return { data: { text: 'q' }, meta: { characters: 1, empty: false } }; },
    path: async (...args) => { calls.push(['path', ...args]); return { data: { text: 'p' }, meta: { characters: 1, empty: false } }; },
    affected: async (...args) => { calls.push(['affected', ...args]); return { data: { text: 'a' }, meta: { characters: 1, empty: false } }; },
  };
  for (const argv of [
    ['knowledge', 'status'],
    ['knowledge', 'query', '--question', 'secret question'],
    ['knowledge', 'path', '--from', 'secret source', '--to', 'secret target', '--graph', 'selected.json'],
    ['knowledge', 'affected', '--node', 'secret node', '--depth', '6'],
  ]) {
    const result = await execute([...argv, '--format', 'json'], { knowledge });
    assert.equal(result.exitCode, 0, result.output);
  }
  assert.deepEqual(calls, [
    ['status', undefined],
    ['query', 'secret question', { graph: undefined, budget: 300 }],
    ['path', 'secret source', 'secret target', { graph: 'selected.json' }],
    ['affected', 'secret node', { graph: undefined, depth: 6 }],
  ]);

  const invalid = await execute(['knowledge', 'query', '--question', 'private-question-7391', '--budget', '49', '--graph', 'private-graph-7391', '--format', 'json'], { knowledge });
  assert.equal(invalid.exitCode, 2);
  assert.equal(JSON.parse(invalid.output).command, 'knowledge query');
  assert.ok(!invalid.output.includes('private-question-7391'));
  assert.ok(!invalid.output.includes('private-graph-7391'));
});

test('CLI knowledge help is compact and exposes no mutation operation', async () => {
  const help = JSON.parse((await execute(['help', 'knowledge', '--format', 'json'])).output);
  assert.deepEqual(help.data.usage, [
    'knowledge status [--graph <graph.json>]',
    'knowledge query --question <text> [--graph <graph.json>] [--budget N]',
    'knowledge path --from <node> --to <node> [--graph <graph.json>]',
    'knowledge affected --node <node> [--graph <graph.json>] [--depth N]',
  ]);
  assert.doesNotMatch(JSON.stringify(help), /refresh|update|watch|build/i);
  for (const action of ['refresh', 'update', 'watch', 'build']) {
    const result = await execute(['knowledge', action, '--format', 'json']);
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.output).error.code, 'unknown-command');
  }
});
