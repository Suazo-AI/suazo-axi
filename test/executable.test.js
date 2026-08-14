import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveExecutable } from '../src/core/executable.js';
import { doctor } from '../src/adapters/doctor.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-suazo-executable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('resolver finds an executable on PATH without running it', async (t) => {
  const root = await fixture(t);
  const executable = path.join(root, process.platform === 'win32' ? 'axi-probe.cmd' : 'axi-probe');
  await fs.writeFile(executable, process.platform === 'win32' ? '@exit /b 99\r\n' : '#!/bin/sh\nexit 99\n');
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
  const found = await resolveExecutable('axi-probe', { env: { PATH: root, PATHEXT: '.CMD' }, platform: process.platform });
  assert.equal(found, executable);
});

test('Windows resolver honors PATHEXT order and absence', async (t) => {
  const root = await fixture(t);
  const command = path.join(root, 'ordered.CUSTOM');
  await fs.writeFile(command, 'not executed');
  assert.equal(await resolveExecutable('ordered', { env: { Path: root, PATHEXT: '.MISSING;.CUSTOM' }, platform: 'win32' }), command);
  assert.equal(await resolveExecutable('ordered', { env: { PATH: root, PATHEXT: '.CMD' }, platform: 'win32' }), null);
});

test('resolver rejects paths and missing commands', async (t) => {
  const root = await fixture(t);
  assert.equal(await resolveExecutable('../tool', { env: { PATH: root }, platform: process.platform }), null);
  assert.equal(await resolveExecutable('missing-tool', { env: { PATH: root }, platform: process.platform }), null);
});

test('doctor degrades a failed GitHub probe and still completes detection', async () => {
  const result = await doctor({
    githubProbe: async () => { throw new Error('probe failure'); },
    vercelProbe: async () => ({ data: { available: true, authenticated: true } }),
    supabaseProbe: async () => ({ data: { available: false, authenticated: false } }),
    codexProbe: async () => ({ data: { available: true, authenticated: false } }),
    knowledgeProbe: async () => ({ data: { available: true } }),
    notionProbe: async () => ({ data: { available: true, authenticated: true } }),
    firecrawlProbe: async () => ({ data: { available: true, authenticated: false } }),
    higgsfieldProbe: async () => ({ data: { available: true, authenticated: false, degraded: true } }),
    dockerProbe: async () => ({ data: { available: true, daemonRunning: true, daemonState: 'running' } }),
    resolver: async (command) => command === 'hermes' ? 'C:/bin/hermes.cmd' : null,
  });
  assert.equal(result.data.adapters.find((item) => item.id === 'github').status, 'degraded');
  assert.equal(result.data.adapters.find((item) => item.id === 'notion').status, 'ready');
  assert.equal(result.data.adapters.find((item) => item.id === 'firecrawl').status, 'authentication-required');
  assert.equal(result.data.adapters.find((item) => item.id === 'higgsfield').status, 'degraded');
  assert.equal(result.data.adapters.find((item) => item.id === 'hermes').status, 'detected');
  assert.equal(result.data.adapters.find((item) => item.id === 'vercel').status, 'ready');
  assert.equal(result.data.adapters.find((item) => item.id === 'supabase').status, 'unavailable');
  assert.equal(result.data.adapters.find((item) => item.id === 'codex').status, 'authentication-required');
});

// `runtimeStatus` is declared in both schemas but no property `$ref`s it, so the enum documents
// the vocabulary without constraining anything. This test makes it load-bearing: every status
// doctor can actually emit has to be a member, so adding an undeclared one fails here.
test('every runtime status doctor emits is declared in the schema enum', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../schemas/result-envelope.schema.json', import.meta.url), 'utf8'));
  const declared = new Set(schema.$defs.runtimeStatus.enum);
  const seen = new Set();

  // Each scenario drives a different branch of the status mapping; together they cover every
  // value doctor is capable of producing.
  const scenarios = [
    { available: true, authenticated: true },
    { available: true, authenticated: false },
    { available: false, authenticated: false },
    { available: true, authenticated: false, degraded: true },
  ];
  const dockerStates = [
    { available: true, daemonRunning: true, daemonState: 'running' },
    { available: true, daemonRunning: false, daemonState: 'stopped' },
    { available: true, daemonRunning: false, daemonState: 'unreachable' },
    { available: false, daemonRunning: false, daemonState: 'cli-missing' },
  ];

  for (const [index, data] of scenarios.entries()) {
    const probe = async () => ({ data });
    const result = await doctor({
      githubProbe: probe,
      vercelProbe: probe,
      supabaseProbe: probe,
      codexProbe: probe,
      knowledgeProbe: probe,
      notionProbe: probe,
      firecrawlProbe: probe,
      higgsfieldProbe: probe,
      dockerProbe: async () => ({ data: dockerStates[index] }),
      resolver: async () => (index % 2 === 0 ? 'C:/bin/hermes.cmd' : null),
    });
    for (const adapter of result.data.adapters) seen.add(adapter.status);
  }

  const undeclared = [...seen].filter((status) => !declared.has(status));
  assert.deepEqual(undeclared, [], `doctor emitted statuses missing from the schema: ${undeclared.join(', ')}`);
  // Guard against the test silently covering nothing if the scenarios stop reaching the branches.
  for (const expected of ['ready', 'authentication-required', 'unavailable', 'degraded', 'daemon-stopped', 'detected', 'not-detected']) {
    assert.ok(seen.has(expected), `scenarios never produced the ${expected} status`);
  }
});

test('doctor degrades thrown provider probes and reports Hermes detection only once', async () => {
  const base = async () => ({ data: { available: true, authenticated: true } });
  const result = await doctor({
    githubProbe: base,
    vercelProbe: base,
    supabaseProbe: base,
    codexProbe: base,
    knowledgeProbe: async () => ({ data: { available: false } }),
    notionProbe: async () => { throw new Error('offline'); },
    firecrawlProbe: async () => ({ data: { available: false, authenticated: false } }),
    higgsfieldProbe: base,
    dockerProbe: async () => ({ data: { available: true, daemonRunning: true, daemonState: 'running' } }),
    resolver: async () => null,
  });
  assert.equal(result.data.adapters.find((item) => item.id === 'knowledge').status, 'unavailable');
  assert.equal(result.data.adapters.find((item) => item.id === 'notion').status, 'degraded');
  assert.equal(result.data.adapters.find((item) => item.id === 'firecrawl').status, 'unavailable');
  assert.equal(result.data.adapters.find((item) => item.id === 'higgsfield').status, 'ready');
  assert.deepEqual(result.data.adapters.filter((item) => item.id === 'hermes'), [{ id: 'hermes', status: 'not-detected' }]);
});
