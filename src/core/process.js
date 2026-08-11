import { spawn } from 'node:child_process';
import { AxiError } from './errors.js';

const TERMINATE_GRACE_MS = 250;
const TERMINATE_HARD_MS = 1_500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalPosixGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* already closed */ }
  }
}

function runTaskkill(pid, force) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    let killer;
    try {
      killer = spawn('taskkill.exe', args, {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      resolve();
      return;
    }
    killer.once('error', resolve);
    killer.once('close', resolve);
  });
}

async function terminateTree(child, closePromise) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await Promise.race([runTaskkill(child.pid, false), delay(TERMINATE_GRACE_MS)]);
    await Promise.race([closePromise, delay(TERMINATE_GRACE_MS)]);
    await Promise.race([runTaskkill(child.pid, true), delay(TERMINATE_GRACE_MS)]);
    await Promise.race([closePromise, delay(TERMINATE_GRACE_MS)]);
    try { child.kill(); } catch { /* already closed */ }
    return;
  }
  signalPosixGroup(child, 'SIGTERM');
  await Promise.race([closePromise, delay(TERMINATE_GRACE_MS)]);
  signalPosixGroup(child, 'SIGKILL');
  await Promise.race([closePromise, delay(TERMINATE_GRACE_MS)]);
}

export function runProcess(file, args, { timeoutMs = 10_000, maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0;
    let settled = false;
    let abortError = null;
    let timeoutTimer;
    let hardTimer;
    let closeResolve;
    const closePromise = new Promise((done) => { closeResolve = done; });

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardTimer);
      fn(value);
    };

    const abort = (error) => {
      if (settled || abortError) return;
      abortError = error;
      hardTimer = setTimeout(() => finish(reject, error), TERMINATE_HARD_MS);
      terminateTree(child, closePromise)
        .catch(() => {})
        .finally(() => finish(reject, error));
    };

    timeoutTimer = setTimeout(() => {
      abort(new AxiError('provider-timeout', `${file} timed out`, { retryable: true }));
    }, timeoutMs);

    for (const stream of ['stdout', 'stderr']) child[stream].on('data', (chunk) => {
      if (abortError) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        abort(new AxiError('provider-output-limit', `${file} exceeded the output cap`));
      } else chunks[stream].push(chunk);
    });

    child.once('error', (error) => {
      closeResolve();
      if (!abortError) finish(reject, new AxiError('adapter-unavailable', `${file} is unavailable`, { details: { cause: error.code || 'spawn-error' } }));
    });
    child.once('close', (code) => {
      closeResolve();
      if (abortError) return;
      finish(resolve, {
        code,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });
    });
  });
}
