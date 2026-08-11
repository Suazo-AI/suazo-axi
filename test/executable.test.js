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
    resolver: async (command) => command === 'ntn' ? 'C:/bin/ntn.cmd' : null,
  });
  assert.equal(result.data.adapters.find((item) => item.id === 'github').status, 'degraded');
  assert.equal(result.data.adapters.find((item) => item.id === 'notion').status, 'detected');
  assert.equal(result.data.adapters.find((item) => item.id === 'vercel').status, 'ready');
  assert.equal(result.data.adapters.find((item) => item.id === 'supabase').status, 'unavailable');
});
