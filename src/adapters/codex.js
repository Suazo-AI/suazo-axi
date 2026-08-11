import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runProcess } from '../core/process.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 1_800_000;
const PROCESS_MARGIN_MS = 30_000;
const OUTPUT_CAP_BYTES = 512_000;
const STATUS_TIMEOUT_MS = 15_000;
const STATUS_OUTPUT_CAP_BYTES = 64_000;
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const EFFORTS = new Set(['low', 'medium', 'high']);

function unavailable() {
  return new AxiError('adapter-unavailable', 'Codex transport is unavailable');
}

async function isFile(file, access, stat) {
  try {
    await access(file);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function resolveCodexTransport({
  home = os.homedir(),
  appData = process.env.APPDATA,
  access = fs.access,
  stat = fs.stat,
  realpath = fs.realpath,
  powershellResolver = resolveExecutable,
} = {}) {
  if (typeof home !== 'string' || !home || typeof appData !== 'string' || !appData) throw unavailable();
  const wrapper = path.resolve(home, '.codex-lean', 'Invoke-CodexLean.ps1');
  const codexScript = path.resolve(appData, 'npm', 'codex.ps1');
  const codexEntry = path.resolve(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  try {
    if (!await isFile(wrapper, access, stat) || !await isFile(codexScript, access, stat) || !await isFile(codexEntry, access, stat)) throw unavailable();
    const powershell = await powershellResolver('powershell.exe');
    if (!powershell) throw unavailable();
    return {
      file: powershell,
      wrapper: await realpath(wrapper),
      codexScript: await realpath(codexScript),
      codexEntry: await realpath(codexEntry),
    };
  } catch {
    throw unavailable();
  }
}

export function validateCodexOptions({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  effort = 'medium',
  mode = 'read-only',
} = {}) {
  if (mode !== 'read-only') throw invalid('invalid-mode', '--mode must be read-only');
  if (!EFFORTS.has(effort)) throw invalid('invalid-effort', '--effort must be low, medium, or high');
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw invalid('invalid-timeout', `--timeout-ms must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return { timeoutMs, effort, mode };
}

async function resolveInputPath(value, kind, { realpath = fs.realpath, stat = fs.stat } = {}) {
  const code = kind === 'file' ? 'invalid-prompt-file' : 'invalid-cwd';
  const message = kind === 'file'
    ? '--prompt-file must be an existing file'
    : '--cwd must be an existing directory';
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw invalid(code, message);
  try {
    const resolved = await realpath(path.resolve(value));
    const info = await stat(resolved);
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new Error('wrong path type');
    return resolved;
  } catch {
    throw invalid(code, message);
  }
}

function sanitizeProcessError(error) {
  if (error?.code === 'adapter-unavailable') return unavailable();
  if (error?.code === 'provider-timeout') {
    return new AxiError('provider-timeout', 'Codex command timed out', {
      retryable: true,
      details: { provider: 'codex' },
    });
  }
  if (error?.code === 'provider-output-limit') {
    return new AxiError('provider-output-limit', 'Codex command exceeded the output cap', {
      retryable: true,
      details: { provider: 'codex' },
    });
  }
  return new AxiError('codex-error', 'Codex command failed', {
    retryable: true,
    details: { provider: 'codex' },
  });
}

export async function codexRun({
  promptFile,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  effort = 'medium',
  mode = 'read-only',
} = {}, {
  transportResolver = resolveCodexTransport,
  runner = runProcess,
  realpath = fs.realpath,
  stat = fs.stat,
} = {}) {
  const validated = validateCodexOptions({ timeoutMs, effort, mode });
  const resolvedPrompt = await resolveInputPath(promptFile, 'file', { realpath, stat });
  const resolvedCwd = await resolveInputPath(cwd, 'directory', { realpath, stat });
  let transport;
  try {
    transport = await transportResolver();
  } catch {
    throw unavailable();
  }
  const args = [
    ...POWERSHELL_ARGS,
    '-File', transport.wrapper,
    '-CodexEntry', transport.codexEntry,
    '-PromptFile', resolvedPrompt,
    '-Cwd', resolvedCwd,
    '-TimeoutMs', String(validated.timeoutMs),
    '-Effort', validated.effort,
    '-Sandbox', 'read-only',
    '-Cleanup',
  ];
  let result;
  try {
    result = await runner(transport.file, args, {
      timeoutMs: validated.timeoutMs + PROCESS_MARGIN_MS,
      maxBytes: OUTPUT_CAP_BYTES,
    });
  } catch (error) {
    throw sanitizeProcessError(error);
  }
  if (result?.code !== 0) {
    throw new AxiError('codex-error', 'Codex command failed', {
      retryable: true,
      details: {
        provider: 'codex',
        ...(Number.isInteger(result?.code) ? { exitCode: result.code } : {}),
      },
    });
  }
  const text = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!text) {
    throw new AxiError('provider-invalid-response', 'Codex returned an empty response', {
      retryable: true,
      details: { provider: 'codex' },
    });
  }
  return {
    data: { text, mode: 'read-only' },
    meta: { characters: text.length, empty: false },
  };
}

export async function codexStatus({
  transportResolver = resolveCodexTransport,
  runner = runProcess,
} = {}) {
  try {
    const transport = await transportResolver();
    const result = await runner(transport.file, [
      ...POWERSHELL_ARGS,
      '-File', transport.codexScript,
      'login', 'status',
    ], {
      timeoutMs: STATUS_TIMEOUT_MS,
      maxBytes: STATUS_OUTPUT_CAP_BYTES,
    });
    if (result?.code === 0) {
      return { data: { available: true, authenticated: true }, meta: { empty: false } };
    }
    if (result?.code === 1) {
      return { data: { available: true, authenticated: false }, meta: { empty: false } };
    }
    return {
      data: { available: true, authenticated: false, degraded: true },
      meta: { empty: false },
    };
  } catch (error) {
    if (error?.code === 'adapter-unavailable') {
      return { data: { available: false, authenticated: false }, meta: { empty: false } };
    }
    return {
      data: { available: true, authenticated: false, degraded: true },
      meta: { empty: false },
    };
  }
}
