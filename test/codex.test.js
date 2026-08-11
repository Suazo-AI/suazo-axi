import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AxiError, invalid } from '../src/core/errors.js';
import { execute } from '../src/cli.js';
import {
  codexRun,
  codexStatus,
  resolveCodexTransport,
} from '../src/adapters/codex.js';

const transport = {
  file: 'powershell.exe',
  wrapper: 'C:\\Users Test\\.codex-lean\\Invoke-CodexLean.ps1',
  codexScript: 'C:\\Users Test\\AppData\\Roaming\\npm\\codex.ps1',
  codexEntry: 'C:\\Users Test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
};

const transportResolver = async () => transport;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-codex-adapter-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace --apply with spaces');
  const promptFile = path.join(root, 'prompt --danger-full-access ;.txt');
  await fs.mkdir(cwd);
  await fs.writeFile(promptFile, 'Do not expose this prompt.');
  return { root, cwd, promptFile };
}

test('Codex run resolves paths and uses exact bounded read-only argv', async (t) => {
  const { cwd, promptFile } = await fixture(t);
  let call;
  const result = await codexRun({
    promptFile,
    cwd: `${cwd}${path.sep}`,
  }, {
    transportResolver,
    runner: async (file, args, options) => {
      call = { file, args, options };
      return { code: 0, stdout: '  AXI-CODEX-RESULT\r\n', stderr: '' };
    },
  });
  const realPrompt = await fs.realpath(promptFile);
  const realCwd = await fs.realpath(cwd);
  assert.deepEqual(call, {
    file: 'powershell.exe',
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', transport.wrapper,
      '-CodexEntry', transport.codexEntry,
      '-PromptFile', realPrompt,
      '-Cwd', realCwd,
      '-TimeoutMs', '300000',
      '-Effort', 'medium',
      '-Sandbox', 'read-only',
      '-Cleanup',
    ],
    options: { timeoutMs: 330_000, maxBytes: 512_000 },
  });
  assert.deepEqual(result, {
    data: { text: 'AXI-CODEX-RESULT', mode: 'read-only' },
    meta: { characters: 16, empty: false },
  });
  assert.ok(!JSON.stringify(result).includes(realPrompt));
  assert.ok(!JSON.stringify(result).includes(realCwd));
});

test('Codex rejects unsafe mode, effort, timeout, and missing paths before invocation', async (t) => {
  const { root, cwd, promptFile } = await fixture(t);
  const directoryPrompt = path.join(root, 'prompt-directory');
  const fileCwd = path.join(root, 'not-a-workspace.txt');
  await fs.mkdir(directoryPrompt);
  await fs.writeFile(fileCwd, 'not a directory');
  let calls = 0;
  const options = {
    transportResolver,
    runner: async () => { calls += 1; return { code: 0, stdout: 'unexpected', stderr: '' }; },
  };

  for (const mode of ['workspace-write', 'danger-full-access', '--apply']) {
    await assert.rejects(() => codexRun({ promptFile, cwd, mode }, options), (error) => error.code === 'invalid-mode');
  }
  for (const effort of ['low --apply', 'xhigh', 'medium;whoami']) {
    await assert.rejects(() => codexRun({ promptFile, cwd, effort }, options), (error) => error.code === 'invalid-effort');
  }
  for (const timeoutMs of [999, 1_800_001, 1.5, '1000']) {
    await assert.rejects(() => codexRun({ promptFile, cwd, timeoutMs }, options), (error) => error.code === 'invalid-timeout');
  }
  await assert.rejects(() => codexRun({ cwd }, options), (error) => error.code === 'invalid-prompt-file');
  await assert.rejects(() => codexRun({ promptFile }, options), (error) => error.code === 'invalid-cwd');
  await assert.rejects(() => codexRun({ promptFile: path.join(root, 'missing.txt'), cwd }, options), (error) => error.code === 'invalid-prompt-file');
  await assert.rejects(() => codexRun({ promptFile: directoryPrompt, cwd }, options), (error) => error.code === 'invalid-prompt-file');
  await assert.rejects(() => codexRun({ promptFile, cwd: fileCwd }, options), (error) => error.code === 'invalid-cwd');
  assert.equal(calls, 0);
});

test('Codex run redacts provider output and preserves bounded failure codes', async (t) => {
  const { cwd, promptFile } = await fixture(t);
  const secret = 'codex-provider-secret-7391';
  await assert.rejects(
    () => codexRun({ promptFile, cwd }, {
      transportResolver,
      runner: async () => ({ code: 17, stdout: secret, stderr: secret }),
    }),
    (error) => error.code === 'codex-error'
      && error.details.exitCode === 17
      && !JSON.stringify(error).includes(secret)
      && !JSON.stringify(error).includes(promptFile)
      && !JSON.stringify(error).includes(cwd),
  );
  for (const code of ['provider-timeout', 'provider-output-limit']) {
    await assert.rejects(
      () => codexRun({ promptFile, cwd }, {
        transportResolver,
        runner: async () => { throw new AxiError(code, `${secret} ${promptFile}`); },
      }),
      (error) => error.code === code && !JSON.stringify(error).includes(secret) && !JSON.stringify(error).includes(promptFile),
    );
  }
  await assert.rejects(
    () => codexRun({ promptFile, cwd }, {
      transportResolver: async () => { throw new AxiError('adapter-unavailable', `${secret} ${promptFile}`); },
    }),
    (error) => error.code === 'adapter-unavailable' && !JSON.stringify(error).includes(secret) && !JSON.stringify(error).includes(promptFile),
  );
});

test('Codex run rejects empty provider responses without leaking provider text', async (t) => {
  const { cwd, promptFile } = await fixture(t);
  await assert.rejects(
    () => codexRun({ promptFile, cwd }, {
      transportResolver,
      runner: async () => ({ code: 0, stdout: ' \r\n ', stderr: 'provider-secret' }),
    }),
    (error) => error.code === 'provider-invalid-response' && !JSON.stringify(error).includes('provider-secret'),
  );
});

test('Codex status uses no model and classifies ready, authentication, unavailable, and degraded', async () => {
  let call;
  const ready = await codexStatus({
    transportResolver,
    runner: async (file, args, options) => {
      call = { file, args, options };
      return { code: 0, stdout: 'Logged in as secret-account', stderr: 'secret-provider' };
    },
  });
  assert.deepEqual(call, {
    file: 'powershell.exe',
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', transport.codexScript, 'login', 'status',
    ],
    options: { timeoutMs: 15_000, maxBytes: 64_000 },
  });
  assert.deepEqual(ready, { data: { available: true, authenticated: true }, meta: { empty: false } });
  assert.ok(!JSON.stringify(ready).includes('secret'));

  const authenticationRequired = await codexStatus({
    transportResolver,
    runner: async () => ({ code: 1, stdout: 'secret-account', stderr: 'secret-provider' }),
  });
  assert.deepEqual(authenticationRequired.data, { available: true, authenticated: false });

  const degradedExit = await codexStatus({
    transportResolver,
    runner: async () => ({ code: 9, stdout: 'secret-account', stderr: 'secret-provider' }),
  });
  assert.deepEqual(degradedExit.data, { available: true, authenticated: false, degraded: true });

  const unavailable = await codexStatus({
    transportResolver: async () => { throw new AxiError('adapter-unavailable', 'secret path'); },
  });
  assert.deepEqual(unavailable.data, { available: false, authenticated: false });

  const degraded = await codexStatus({
    transportResolver,
    runner: async () => { throw new AxiError('provider-timeout', 'secret path'); },
  });
  assert.deepEqual(degraded.data, { available: true, authenticated: false, degraded: true });
  assert.ok(!JSON.stringify(degraded).includes('secret'));
});

test('Codex transport resolves only the fixed wrapper, login script, and PowerShell', async () => {
  const seen = [];
  const home = 'C:\\Users Test';
  const appData = 'C:\\Users Test\\AppData\\Roaming';
  const expectedWrapper = path.resolve(home, '.codex-lean', 'Invoke-CodexLean.ps1');
  const expectedScript = path.resolve(appData, 'npm', 'codex.ps1');
  const expectedEntry = path.resolve(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const resolved = await resolveCodexTransport({
    home,
    appData,
    access: async (file) => { seen.push(file); },
    stat: async () => ({ isFile: () => true }),
    realpath: async (file) => file,
    powershellResolver: async (command) => {
      assert.equal(command, 'powershell.exe');
      return 'powershell.exe';
    },
  });
  assert.deepEqual(seen, [expectedWrapper, expectedScript, expectedEntry]);
  assert.deepEqual(resolved, {
    file: 'powershell.exe',
    wrapper: expectedWrapper,
    codexScript: expectedScript,
    codexEntry: expectedEntry,
  });
  await assert.rejects(
    () => resolveCodexTransport({
      home,
      appData,
      access: async () => { throw new Error('missing'); },
      stat: async () => ({ isFile: () => true }),
      powershellResolver: async () => 'powershell.exe',
    }),
    (error) => error.code === 'adapter-unavailable' && !JSON.stringify(error).includes(home),
  );
});

test('Codex execute routing keeps compact and JSON envelopes, help, labels, and flag isolation', async () => {
  let runInput;
  const codex = {
    status: async () => ({ data: { available: true, authenticated: true }, meta: { empty: false } }),
    run: async (input) => {
      runInput = input;
      return { data: { text: 'done', mode: 'read-only' }, meta: { characters: 4, empty: false } };
    },
  };
  const json = await execute([
    'codex', 'run',
    '--prompt-file', 'C:\\Prompt Files\\task.md',
    '--cwd', 'C:\\Work Dir\\',
    '--timeout-ms', '1200',
    '--effort', 'high',
    '--mode', 'read-only',
    '--format', 'json',
  ], { codex });
  assert.equal(json.exitCode, 0);
  const parsed = JSON.parse(json.output);
  assert.equal(parsed.command, 'codex run');
  assert.deepEqual(runInput, {
    promptFile: 'C:\\Prompt Files\\task.md',
    cwd: 'C:\\Work Dir\\',
    timeoutMs: 1200,
    effort: 'high',
    mode: 'read-only',
  });
  assert.deepEqual(parsed.data, { text: 'done', mode: 'read-only' });
  assert.match((await execute(['codex', 'status'], { codex })).output, /command: "codex status"/);
  assert.match((await execute(['help', 'codex'], { codex })).output, /codex run/);

  const labeled = await execute([
    'codex', 'run', '--prompt-file', 'secret-prompt-path', '--cwd', 'secret-cwd', '--mode', 'workspace-write', '--format', 'json',
  ], { codex: { ...codex, run: async () => { throw invalid('invalid-mode', 'mode must be read-only'); } } });
  assert.equal(JSON.parse(labeled.output).command, 'codex run');
  assert.ok(!labeled.output.includes('secret-prompt-path'));
  assert.ok(!labeled.output.includes('secret-cwd'));

  const isolated = await execute(['files', 'list', '--effort', 'high', '--format', 'json']);
  assert.equal(JSON.parse(isolated.output).error.code, 'invalid-flag');

  const blocked = await execute(['codex', 'run', '--apply', '--format', 'json']);
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.output, /command: "codex run"/);
});
