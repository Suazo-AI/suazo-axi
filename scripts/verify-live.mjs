#!/usr/bin/env node
// Deterministic live verifier.
//
// The offline suite proves the normalizers agree with their fixtures. It cannot prove the
// fixtures agree with the providers: a fixture that encodes the same wrong field name as the
// code is green against a fiction. This script closes that gap by exercising every read-only
// operation against the real CLIs and judging the result mechanically.
//
// Exit codes are the whole point. "Verified" means this exited 0, not that someone said so.
//
//   0  every check ran and passed
//   1  at least one check failed
//   2  every check that ran passed, but some were skipped because their provider was absent
//
// A skip can never produce a 0. Silence about coverage is the failure mode this exists to stop.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = path.join(ROOT, 'bin', 'suazo-axi.js');
const REPORT_DIR = path.join(ROOT, '.verify');
const TIMEOUT_MS = 60_000;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args, '--format', 'json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

async function invoke(args) {
  const result = await run(args);
  if (result.timedOut) return { envelope: null, reason: `timed out after ${TIMEOUT_MS} ms` };
  try {
    return { envelope: JSON.parse(result.stdout), reason: null };
  } catch {
    return { envelope: null, reason: `stdout was not JSON: ${result.stdout.slice(0, 200)}` };
  }
}

// `check` is the mechanical judge. It receives the parsed envelope and returns null when the
// check passes or a string explaining the defect. Returning a string is the only way to fail.
const CHECKS = [
  {
    name: 'doctor',
    args: ['doctor'],
    check: (e) => {
      if (!e.ok) return 'doctor reported ok:false';
      if (!Array.isArray(e.data?.adapters) || e.data.adapters.length === 0) return 'no adapters listed';
      if (!e.data.runtime?.supported) return 'runtime reported unsupported';
      return null;
    },
  },
  {
    name: 'integrations list',
    args: ['integrations', 'list'],
    check: (e) => {
      if (!e.ok) return 'integrations list reported ok:false';
      const items = e.data?.items;
      if (!Array.isArray(items) || items.length === 0) return 'no integrations listed';
      const bad = items.find((item) => !item.id || !item.status);
      return bad ? `integration missing id or status: ${JSON.stringify(bad)}` : null;
    },
  },
];

// Each provider declares a status probe plus the operations that only make sense once that
// probe says the provider is reachable. Gating this way keeps an unreachable provider from
// masquerading as a pass, and keeps a reachable one from being quietly skipped.
const PROVIDERS = [
  {
    id: 'notion',
    probe: ['notion', 'status'],
    reachable: (e) => e.ok === true && e.data?.authenticated === true,
    operations: [
      {
        name: 'notion search',
        args: ['notion', 'search', '--query', 'a', '--limit', '3'],
        check: (e) => (e.ok ? null : 'search reported ok:false'),
      },
    ],
  },
  {
    id: 'firecrawl',
    probe: ['firecrawl', 'status'],
    reachable: (e) => e.ok === true && e.data?.authenticated === true,
    operations: [
      {
        name: 'firecrawl map',
        args: ['firecrawl', 'map', '--url', 'https://example.com', '--limit', '3'],
        check: (e) => (e.ok ? null : 'map reported ok:false'),
      },
    ],
  },
  {
    id: 'higgsfield',
    probe: ['higgsfield', 'status'],
    reachable: (e) => e.ok === true && e.data?.authenticated === true,
    operations: [
      {
        name: 'higgsfield model list',
        args: ['higgsfield', 'model', 'list', '--limit', '3'],
        check: (e) => {
          if (!e.ok) return 'model list reported ok:false';
          const first = e.data?.items?.[0];
          if (!first) return null;
          return first.id && first.name && first.kind ? null : `model missing fields: ${JSON.stringify(first)}`;
        },
      },
      {
        name: 'higgsfield generation list',
        args: ['higgsfield', 'generation', 'list', '--limit', '3'],
        check: (e) => (e.ok ? null : 'generation list reported ok:false'),
      },
    ],
  },
  {
    id: 'docker',
    probe: ['docker', 'status'],
    // The daemon being stopped is a legitimate environment state, not a defect, so it skips
    // rather than fails. What is never acceptable is the status call itself erroring out.
    reachable: (e) => e.ok === true && e.data?.daemonRunning === true,
    operations: [
      {
        name: 'docker container list',
        args: ['docker', 'container', 'list', '--all', '--limit', '3'],
        check: (e) => (e.ok ? null : 'container list reported ok:false'),
      },
      {
        name: 'docker image list',
        args: ['docker', 'image', 'list', '--limit', '3'],
        check: (e) => (e.ok ? null : 'image list reported ok:false'),
      },
      {
        name: 'docker compose list',
        args: ['docker', 'compose', 'list'],
        check: (e) => (e.ok ? null : 'compose list reported ok:false'),
      },
    ],
  },
];

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail: detail ?? null });
  const mark = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? `  - ${detail}` : ''}`);
}

async function runCheck({ name, args, check }) {
  const { envelope, reason } = await invoke(args);
  if (!envelope) {
    record(name, 'fail', reason);
    return;
  }
  const defect = check(envelope);
  if (defect) record(name, 'fail', defect);
  else record(name, 'pass');
}

for (const check of CHECKS) {
  await runCheck(check);
}

for (const provider of PROVIDERS) {
  const { envelope, reason } = await invoke(provider.probe);
  if (!envelope) {
    record(`${provider.id} status`, 'fail', reason);
    for (const op of provider.operations) record(op.name, 'skip', 'status probe produced no envelope');
    continue;
  }
  if (!envelope.ok) {
    record(`${provider.id} status`, 'fail', 'status reported ok:false');
    for (const op of provider.operations) record(op.name, 'skip', 'status reported ok:false');
    continue;
  }
  record(`${provider.id} status`, 'pass');
  if (!provider.reachable(envelope)) {
    const state = JSON.stringify(envelope.data);
    for (const op of provider.operations) record(op.name, 'skip', `provider not reachable: ${state}`);
    continue;
  }
  for (const op of provider.operations) await runCheck(op);
}

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip');
const passed = results.filter((r) => r.status === 'pass');
const exitCode = failed.length > 0 ? 1 : skipped.length > 0 ? 2 : 0;

await fs.mkdir(REPORT_DIR, { recursive: true });
await fs.writeFile(
  path.join(REPORT_DIR, 'live-report.json'),
  `${JSON.stringify({ exitCode, passed: passed.length, failed: failed.length, skipped: skipped.length, results }, null, 2)}\n`,
);

console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
console.log(`report: ${path.join(REPORT_DIR, 'live-report.json')}`);
if (exitCode === 2) console.log('exit 2: everything that ran passed, but coverage was incomplete');
process.exit(exitCode);
