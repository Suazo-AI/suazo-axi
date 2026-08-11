import { resolveExecutable } from '../core/executable.js';
import { githubStatus } from './github.js';
import { vercelStatus } from './vercel.js';
import { supabaseAccessStatus } from './supabase.js';

const CLI_PROBES = [
  ['notion', 'ntn'],
  ['firecrawl', 'firecrawl'],
  ['higgsfield', 'higgsfield'],
];

export async function doctor({ githubProbe = githubStatus, vercelProbe = vercelStatus, supabaseProbe = supabaseAccessStatus, resolver = resolveExecutable } = {}) {
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
  const probes = await Promise.all(CLI_PROBES.map(async ([id, command]) => ({ id, available: Boolean(await resolver(command)) })));
  const adapters = [
    { id: 'files', status: 'ready' },
    { id: 'github', status: github.data.degraded ? 'degraded' : github.data.available ? (github.data.authenticated ? 'ready' : 'authentication-required') : 'unavailable' },
    { id: 'vercel', status: vercel.data.degraded ? 'degraded' : vercel.data.available ? (vercel.data.authenticated ? 'ready' : 'authentication-required') : 'unavailable' },
    { id: 'supabase', status: supabase.data.degraded ? 'degraded' : supabase.data.available ? (supabase.data.authenticated ? 'ready' : 'authentication-required') : 'unavailable' },
    ...probes.map((probe) => ({ id: probe.id, status: probe.available ? 'detected' : 'not-detected' })),
    { id: 'outlook-email', status: 'host-bridge-required' },
    { id: 'stitch', status: 'host-bridge-required' },
    { id: 'hermes', status: 'host-bridge-required' },
    { id: 'browser', status: 'host-bridge-required' },
    { id: 'calendar', status: 'unconfigured' },
  ];
  return {
    data: { runtime: { node: process.version, supported: Number(process.versions.node.split('.')[0]) >= 20 }, adapters },
    meta: { total: adapters.length, ready: adapters.filter((item) => item.status === 'ready').length, empty: false },
  };
}
