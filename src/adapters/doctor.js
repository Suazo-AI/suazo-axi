import { resolveExecutable } from '../core/executable.js';
import { githubStatus } from './github.js';
import { vercelStatus } from './vercel.js';
import { supabaseAccessStatus } from './supabase.js';
import { codexStatus } from './codex.js';
import { knowledgeStatus } from './knowledge.js';
import { codegraphStatus } from './codegraph.js';
import { notionStatus } from './notion.js';
import { firecrawlStatus } from './firecrawl.js';
import { higgsfieldStatus } from './higgsfield.js';
import { dockerStatus } from './docker.js';

const CLI_PROBES = [
  ['hermes', 'hermes'],
];

function adapterStatus(result) {
  return result.data.degraded
    ? 'degraded'
    : result.data.available
      ? (result.data.authenticated ? 'ready' : 'authentication-required')
      : 'unavailable';
}

// The CLI being present is not the same as the graph being queryable: cgr needs its
// Memgraph container up. That distinction is exactly what `daemon-stopped` is for.
function codegraphAdapterStatus(result) {
  if (result.data.degraded) return 'degraded';
  if (!result.data.available) return 'unavailable';
  return result.data.stackRunning && result.data.memgraphReachable ? 'ready' : 'daemon-stopped';
}

function dockerAdapterStatus(result) {
  if (!result.data.available) return 'unavailable';
  if (result.data.daemonState === 'stopped') return 'daemon-stopped';
  if (result.data.daemonState === 'running') return 'ready';
  return 'degraded';
}

async function safeProbe(probe) {
  try { return await probe(); } catch {
    return { data: { available: true, authenticated: false, degraded: true } };
  }
}

// Every probe is an ordinary defaulted parameter. An earlier revision inferred a "partial
// harness" from which probes the caller passed and silently swapped the rest for degraded stubs,
// so `doctor({ githubProbe })` quietly stopped consulting Notion, Firecrawl, Higgsfield and
// Docker. That existed only to spare tests from injecting every probe, and no reader of the
// signature could have predicted it. Tests inject what they need; production reads the defaults.
export async function doctor({
  githubProbe = githubStatus,
  vercelProbe = vercelStatus,
  supabaseProbe = supabaseAccessStatus,
  codexProbe = codexStatus,
  knowledgeProbe,
  notionProbe = notionStatus,
  firecrawlProbe = firecrawlStatus,
  higgsfieldProbe = higgsfieldStatus,
  dockerProbe = dockerStatus,
  codegraphProbe = codegraphStatus,
  resolver = resolveExecutable,
} = {}) {
  let github;
  try { github = await githubProbe(); } catch {
    github = { data: { available: true, authenticated: false, degraded: true } };
  }
  let vercel;
  try { vercel = await vercelProbe(); } catch {
    vercel = { data: { available: true, authenticated: false, degraded: true } };
  }
  let supabase;
  try { supabase = await supabaseProbe(); } catch {
    supabase = { data: { available: true, authenticated: false, degraded: true } };
  }
  let codex;
  try { codex = await codexProbe(); } catch {
    codex = { data: { available: true, authenticated: false, degraded: true } };
  }
  let knowledge;
  try {
    knowledge = await (knowledgeProbe || (() => knowledgeStatus(undefined, { resolver })))();
  } catch {
    knowledge = { data: { available: true, degraded: true } };
  }
  const [notion, firecrawl, higgsfield, docker, codegraph] = await Promise.all([
    safeProbe(notionProbe),
    safeProbe(firecrawlProbe),
    safeProbe(higgsfieldProbe),
    safeProbe(dockerProbe),
    safeProbe(codegraphProbe),
  ]);
  const probes = await Promise.all(CLI_PROBES.map(async ([id, command]) => ({ id, available: Boolean(await resolver(command)) })));
  const adapters = [
    { id: 'files', status: 'ready' },
    { id: 'knowledge', status: knowledge.data.degraded ? 'degraded' : knowledge.data.available ? 'ready' : 'unavailable' },
    { id: 'codegraph', status: codegraphAdapterStatus(codegraph) },
    { id: 'github', status: github.data.degraded ? 'degraded' : github.data.available ? (github.data.authenticated ? 'ready' : 'authentication-required') : 'unavailable' },
    { id: 'vercel', status: vercel.data.degraded ? 'degraded' : vercel.data.available ? (vercel.data.authenticated ? 'ready' : 'authentication-required') : 'unavailable' },
    { id: 'supabase', status: supabase.data.degraded ? 'degraded' : supabase.data.available ? (supabase.data.authenticated ? 'ready' : 'authentication-required') : 'unavailable' },
    { id: 'codex', status: codex.data.degraded ? 'degraded' : codex.data.available ? (codex.data.authenticated ? 'ready' : 'authentication-required') : 'unavailable' },
    { id: 'notion', status: adapterStatus(notion) },
    { id: 'firecrawl', status: adapterStatus(firecrawl) },
    { id: 'higgsfield', status: adapterStatus(higgsfield) },
    { id: 'docker', status: dockerAdapterStatus(docker) },
    ...probes.map((probe) => ({ id: probe.id, status: probe.available ? 'detected' : 'not-detected' })),
    { id: 'outlook-email', status: 'host-bridge-required' },
    { id: 'stitch', status: 'host-bridge-required' },
    { id: 'browser', status: 'host-bridge-required' },
    { id: 'calendar', status: 'unconfigured' },
  ];
  return {
    data: { runtime: { node: process.version, supported: Number(process.versions.node.split('.')[0]) >= 20 }, adapters },
    meta: { total: adapters.length, ready: adapters.filter((item) => item.status === 'ready').length, empty: false },
  };
}
