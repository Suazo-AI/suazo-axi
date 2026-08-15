#!/usr/bin/env node
// Deterministic live verifier.
//
// The offline suite proves the normalizers agree with their fixtures. It cannot prove the
// fixtures agree with the providers: a fixture that encodes the same wrong field name as the
// code is green against a fiction. This script closes that gap by driving the real CLIs.
//
// Exit codes are the whole point. "Verified" means this exited 0, not that someone said so.
//
//   0  every adapter was exercised and every required check passed
//   1  a required check failed, or an adapter was not exercised at all
//   2  everything required passed, but an optional check was skipped
//
// Two rules keep the 0 honest:
//
//   - Every adapter in src/adapters must appear below. The run fails if one is missing, so
//     adding an adapter without adding coverage cannot silently pass.
//   - A `required` check never skips. Checks whose precondition genuinely may be absent on a
//     given machine (no knowledge graph, no local Supabase project, Docker engine off) are
//     `optional`, and skipping one is printed, counted, and downgrades the exit to 2.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = path.join(ROOT, 'bin', 'suazo-axi.js');
const ADAPTER_DIR = path.join(ROOT, 'src', 'adapters');
const REPORT_DIR = path.join(ROOT, '.verify');
const TIMEOUT_MS = 90_000;

// `doctor` is an adapter file but it is the aggregate probe rather than a provider, so it is
// covered by the top-level checks instead of a provider block. Listing it here keeps the
// completeness assertion honest rather than special-casing it away.
const COVERED_BY_TOP_LEVEL = new Set(['doctor']);

// Deliberately never exercised: `codex run` spawns a real agent. Verifying it would cost a
// model run per invocation, so the adapter is covered by its status probe only, and this
// exclusion is printed in the summary rather than left implicit.
const EXCLUDED_OPERATIONS = ['codex run (spawns a billed agent)'];

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args, '--format', 'json'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ stdout, timedOut: true });
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, timedOut: false });
    });
  });
}

async function invoke(args) {
  const result = await run(args);
  if (result.timedOut) return { envelope: null, reason: `timed out after ${TIMEOUT_MS} ms` };
  try {
    return { envelope: JSON.parse(result.stdout), reason: null };
  } catch {
    return { envelope: null, reason: `stdout was not JSON: ${result.stdout.slice(0, 160)}` };
  }
}

// The default judge: the envelope has to report success. Individual checks tighten this when
// there is a shape worth pinning, because `ok: true` with an empty payload proves little.
const ok = (e) => (e.ok ? null : `reported ok:false${e.error ? ` (${e.error.code})` : ''}`);

function itemsHaveFields(...fields) {
  return (e) => {
    const failure = ok(e);
    if (failure) return failure;
    const first = e.data?.items?.[0];
    if (!first) return null;
    const missing = fields.filter((field) => first[field] === undefined || first[field] === null);
    return missing.length === 0 ? null : `first item missing ${missing.join(', ')}: ${JSON.stringify(first)}`;
  };
}

const ADAPTERS = [
  {
    id: 'files',
    required: [
      { name: 'files list', args: ['files', 'list'], check: itemsHaveFields('name', 'type', 'path') },
      { name: 'files read', args: ['files', 'read', 'package.json', '--max-chars', '400'], check: ok },
      { name: 'files find', args: ['files', 'find', 'adapters', '--limit', '3'], check: ok },
    ],
  },
  {
    id: 'knowledge',
    probe: { name: 'knowledge status', args: ['knowledge', 'status'], check: ok },
    optional: [
      {
        name: 'knowledge query',
        args: ['knowledge', 'query', '--question', 'what does the docker adapter do'],
        check: ok,
        // graphify-out/graph.json is a build artifact and is gitignored, so a clean checkout
        // legitimately has none. Gate rather than fail.
        precondition: (probe) => (probe.data?.graphExists ? null : 'no knowledge graph in this checkout'),
      },
    ],
  },
  {
    id: 'codegraph',
    probe: { name: 'codegraph status', args: ['codegraph', 'status'], check: ok },
    optional: [
      {
        name: 'codegraph stats',
        args: ['codegraph', 'stats'],
        check: ok,
        // The graph lives in Memgraph, not in the checkout, so a machine without the
        // cgr stack up legitimately has nothing to count. Gate rather than fail.
        precondition: (probe) => (probe.data?.memgraphReachable ? null : 'cgr stack is not running'),
      },
      {
        name: 'codegraph dead-code',
        args: (probe) => ['codegraph', 'dead-code', '--project', probe.data.projects[0].name, '--limit', '3'],
        check: ok,
        precondition: (probe) => (probe.data?.projects?.length ? null : 'no project synced into the cgr graph'),
      },
    ],
  },
  {
    id: 'github',
    probe: { name: 'github status', args: ['github', 'status'], check: (e) => (e.ok && e.data?.authenticated ? null : 'not authenticated') },
    required: [
      { name: 'github repo view', args: ['github', 'repo', 'view'], check: ok },
      { name: 'github pr list', args: ['github', 'pr', 'list', '--limit', '3'], check: ok },
      { name: 'github issue list', args: ['github', 'issue', 'list', '--limit', '3'], check: ok },
      { name: 'github run list', args: ['github', 'run', 'list', '--limit', '3'], check: ok },
    ],
  },
  {
    id: 'vercel',
    // The CLI exposes no `vercel status`, so the list operation is both probe and check.
    required: [
      { name: 'vercel deployment list', args: ['vercel', 'deployment', 'list', '--limit', '3'], check: ok },
    ],
  },
  {
    id: 'supabase',
    required: [
      { name: 'supabase projects list', args: ['supabase', 'projects', 'list', '--limit', '3'], check: itemsHaveFields('name') },
    ],
    optional: [
      {
        name: 'supabase status',
        args: ['supabase', 'status', '--workdir', ROOT],
        check: ok,
        // Needs a Supabase project rooted at the workdir. This repo is not one, and pointing it
        // elsewhere would make the result depend on an unrelated checkout.
        precondition: () => 'this repo is not a local Supabase project',
      },
    ],
  },
  {
    id: 'codex',
    required: [
      { name: 'codex status', args: ['codex', 'status'], check: (e) => (e.ok && e.data?.authenticated ? null : 'not authenticated') },
    ],
  },
  {
    id: 'notion',
    probe: { name: 'notion status', args: ['notion', 'status'], check: (e) => (e.ok && e.data?.authenticated ? null : 'not authenticated') },
    required: [
      { name: 'notion search', args: ['notion', 'search', '--query', 'a', '--limit', '3'], check: itemsHaveFields('id', 'url') },
    ],
  },
  {
    id: 'firecrawl',
    probe: { name: 'firecrawl status', args: ['firecrawl', 'status'], check: (e) => (e.ok && e.data?.authenticated ? null : 'not authenticated') },
    required: [
      // Costs a small number of Firecrawl credits per run. That is the price of proving the
      // search normalizer against the live response shape rather than against a fixture.
      { name: 'firecrawl search', args: ['firecrawl', 'search', '--query', 'axi agent experience interface', '--limit', '2'], check: itemsHaveFields('url') },
      { name: 'firecrawl map', args: ['firecrawl', 'map', '--url', 'https://example.com', '--limit', '3'], check: itemsHaveFields('url') },
    ],
  },
  {
    id: 'higgsfield',
    probe: { name: 'higgsfield status', args: ['higgsfield', 'status'], check: (e) => (e.ok && e.data?.authenticated ? null : 'not authenticated') },
    required: [
      { name: 'higgsfield model list', args: ['higgsfield', 'model', 'list', '--limit', '3'], check: itemsHaveFields('id', 'name', 'kind') },
      { name: 'higgsfield generation list', args: ['higgsfield', 'generation', 'list', '--limit', '3'], check: itemsHaveFields('id', 'status', 'model') },
    ],
  },
  {
    id: 'docker',
    probe: { name: 'docker status', args: ['docker', 'status'], check: ok },
    optional: [
      {
        name: 'docker container list',
        args: ['docker', 'container', 'list', '--all', '--limit', '3'],
        check: itemsHaveFields('id', 'name', 'image', 'state'),
        precondition: (probe) => (probe.data?.daemonRunning ? null : `engine ${probe.data?.daemonState ?? 'unknown'}`),
      },
      {
        name: 'docker image list',
        args: ['docker', 'image', 'list', '--limit', '3'],
        check: itemsHaveFields('id', 'repository', 'tag'),
        precondition: (probe) => (probe.data?.daemonRunning ? null : `engine ${probe.data?.daemonState ?? 'unknown'}`),
      },
      {
        name: 'docker compose list',
        args: ['docker', 'compose', 'list'],
        check: ok,
        precondition: (probe) => (probe.data?.daemonRunning ? null : `engine ${probe.data?.daemonState ?? 'unknown'}`),
      },
    ],
  },
];

const TOP_LEVEL = [
  {
    name: 'doctor',
    args: ['doctor'],
    check: (e) => {
      const failure = ok(e);
      if (failure) return failure;
      if (!Array.isArray(e.data?.adapters) || e.data.adapters.length === 0) return 'no adapters listed';
      return e.data.runtime?.supported ? null : 'runtime reported unsupported';
    },
  },
  {
    name: 'integrations list',
    args: ['integrations', 'list'],
    check: (e) => {
      const failure = ok(e);
      if (failure) return failure;
      const items = e.data?.items;
      if (!Array.isArray(items) || items.length === 0) return 'no integrations listed';
      const bad = items.find((item) => !item.id || !item.status);
      return bad ? `integration missing id or status: ${JSON.stringify(bad)}` : null;
    },
  },
];

const results = [];

function record(adapter, name, status, detail) {
  results.push({ adapter, name, status, detail: detail ?? null });
  const mark = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? `  - ${detail}` : ''}`);
}

// `args` may be a function of the probe envelope. Some identifiers are only knowable at
// runtime - a cgr project key carries a content hash - and hardcoding one would make the
// check pass on this machine and fail on every other.
async function runCheck(adapter, { name, args, check }, probeEnvelope = null) {
  const resolvedArgs = typeof args === 'function' ? args(probeEnvelope ?? { data: {} }) : args;
  const { envelope, reason } = await invoke(resolvedArgs);
  if (!envelope) {
    record(adapter, name, 'fail', reason);
    return null;
  }
  const defect = check(envelope);
  if (defect) {
    record(adapter, name, 'fail', defect);
    return null;
  }
  record(adapter, name, 'pass');
  return envelope;
}

// Completeness gate. An adapter added to src/adapters without a block above fails the run,
// which is what stops coverage from silently rotting back to a subset.
const adapterFiles = (await fs.readdir(ADAPTER_DIR))
  .filter((file) => file.endsWith('.js'))
  .map((file) => path.basename(file, '.js'));
const declared = new Set([...ADAPTERS.map((a) => a.id), ...COVERED_BY_TOP_LEVEL]);
const uncovered = adapterFiles.filter((id) => !declared.has(id));

for (const check of TOP_LEVEL) await runCheck('doctor', check);

for (const adapter of ADAPTERS) {
  let probeEnvelope = null;
  if (adapter.probe) {
    probeEnvelope = await runCheck(adapter.id, adapter.probe);
    if (!probeEnvelope) {
      for (const op of [...(adapter.required ?? []), ...(adapter.optional ?? [])]) {
        record(adapter.id, op.name, 'fail', 'status probe failed');
      }
      continue;
    }
  }
  for (const op of adapter.required ?? []) await runCheck(adapter.id, op, probeEnvelope);
  for (const op of adapter.optional ?? []) {
    const blocked = op.precondition(probeEnvelope ?? { data: {} });
    if (blocked) record(adapter.id, op.name, 'skip', blocked);
    else await runCheck(adapter.id, op, probeEnvelope);
  }
}

const failed = results.filter((r) => r.status === 'fail');
const skipped = results.filter((r) => r.status === 'skip');
const passed = results.filter((r) => r.status === 'pass');
const exercised = new Set(results.filter((r) => r.status === 'pass').map((r) => r.adapter));
const notExercised = adapterFiles.filter((id) => !exercised.has(id));

const exitCode = failed.length > 0 || uncovered.length > 0 || notExercised.length > 0
  ? 1
  : skipped.length > 0 ? 2 : 0;

await fs.mkdir(REPORT_DIR, { recursive: true });
await fs.writeFile(
  path.join(REPORT_DIR, 'live-report.json'),
  `${JSON.stringify({
    exitCode,
    adapters: { total: adapterFiles.length, exercised: exercised.size, notExercised, undeclared: uncovered },
    checks: { passed: passed.length, failed: failed.length, skipped: skipped.length },
    excludedOperations: EXCLUDED_OPERATIONS,
    results,
  }, null, 2)}\n`,
);

console.log(`\nadapters exercised: ${exercised.size}/${adapterFiles.length}`);
console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
for (const excluded of EXCLUDED_OPERATIONS) console.log(`not verified by design: ${excluded}`);
if (uncovered.length > 0) console.log(`adapters with no coverage declared: ${uncovered.join(', ')}`);
if (notExercised.length > 0) console.log(`adapters that never passed a check: ${notExercised.join(', ')}`);
console.log(`report: ${path.join(REPORT_DIR, 'live-report.json')}`);
if (exitCode === 2) console.log('exit 2: everything required passed, coverage was environment-limited');
process.exit(exitCode);
