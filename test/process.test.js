import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../src/core/process.js';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('subprocess helper enforces the combined output cap', async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { maxBytes: 64 }),
    (error) => error.code === 'provider-output-limit',
  );
});

test('subprocess helper enforces timeouts', async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }),
    (error) => error.code === 'provider-timeout' && error.retryable,
  );
});

test('subprocess helper returns normal output unchanged', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'ok');
});

test('timeout terminates an uncooperative descendant process', { timeout: 5_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-suazo-process-'));
  const pidFile = path.join(root, 'child.pid');
  let descendantPid;
  t.after(async () => {
    if (descendantPid && alive(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already closed */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const childScript = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
  const parentScript = [
    'const fs=require("node:fs")',
    'const {spawn}=require("node:child_process")',
    `const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"})`,
    'fs.writeFileSync(process.argv[1],String(child.pid))',
    'process.on("SIGTERM",()=>{})',
    'setInterval(()=>{},1000)',
  ].join(';');
  await assert.rejects(
    () => runProcess(process.execPath, ['-e', parentScript, pidFile], { timeoutMs: 250 }),
    (error) => error.code === 'provider-timeout',
  );
  descendantPid = Number(await fs.readFile(pidFile, 'utf8'));
  for (let attempt = 0; attempt < 20 && alive(descendantPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive(descendantPid), false);
});
