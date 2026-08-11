import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AxiError, invalid } from '../core/errors.js';
import { resolveExecutable } from '../core/executable.js';
import { runJsonCli } from '../core/cli-provider.js';

const HOST_PATTERN = /^(?:https:\/\/)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const ID_PATTERN = /^dpl_[A-Za-z0-9]+$/;

export function validateProject(project) {
  if (project === undefined) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(project)) {
    throw invalid('invalid-project', 'project must start with a letter or number and use only letters, numbers, dots, underscores, or hyphens');
  }
}

export function validateDeployment(deployment) {
  if (!deployment || (!ID_PATTERN.test(deployment) && !HOST_PATTERN.test(deployment))) {
    throw invalid('invalid-deployment', 'deployment must be a Vercel deployment ID or hostname');
  }
}

function normalizeUrl(value) {
  if (!value) return null;
  return String(value).startsWith('http://') || String(value).startsWith('https://') ? String(value) : `https://${value}`;
}

function normalizeTime(value) {
  if (value === undefined || value === null) return null;
  const date = new Date(typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function normalizeDeployment(value) {
  return {
    reference: value.id || value.uid || value.url || null,
    id: value.id || value.uid || null,
    project: value.name || value.project?.name || null,
    url: normalizeUrl(value.url),
    state: String(value.state || value.readyState || '').toLowerCase() || null,
    target: value.target || null,
    createdAt: normalizeTime(value.createdAt ?? value.created),
  };
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

export async function resolveVercelTransport({ resolver = resolveExecutable, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const secureShim = await resolver('vercel-secure');
    if (secureShim) {
      const script = path.join(path.dirname(secureShim), 'Invoke-VercelSecure.ps1');
      const powershell = await resolver('powershell.exe') || await resolver('powershell');
      if (powershell && await exists(script)) {
        return {
          file: powershell,
          prefixArgs: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
          auth: 'secure-wrapper',
        };
      }
    }
  }

  const executable = await resolver('vercel');
  if (!executable) throw new AxiError('adapter-unavailable', 'Vercel CLI is unavailable');
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    const entry = path.join(path.dirname(executable), 'node_modules', 'vercel', 'dist', 'vc.js');
    if (await exists(entry)) return { file: process.execPath, prefixArgs: [entry], auth: 'vercel-cli' };
    throw new AxiError('adapter-unavailable', 'Vercel CLI launcher is unavailable');
  }
  return { file: executable, prefixArgs: [], auth: 'vercel-cli' };
}

async function invoke(args, { transportResolver = resolveVercelTransport, runner } = {}) {
  const transport = await transportResolver();
  return runJsonCli({
    provider: 'vercel',
    file: transport.file,
    prefixArgs: transport.prefixArgs,
    args,
    timeoutMs: 20_000,
    maxBytes: 1_000_000,
    runner,
  });
}

export async function vercelStatus(options = {}) {
  try {
    await invoke(['whoami', '--json', '--non-interactive', '--no-color'], options);
    return { data: { available: true, authenticated: true }, meta: { empty: false } };
  } catch (error) {
    if (error.code === 'adapter-unavailable') return { data: { available: false, authenticated: false }, meta: { empty: false } };
    if (error.code === 'vercel-error' || error.code === 'provider-invalid-response') {
      return { data: { available: true, authenticated: false }, meta: { empty: false } };
    }
    throw error;
  }
}

export async function deploymentList(project, limit, options = {}) {
  validateProject(project);
  const args = ['list'];
  if (project) args.push(project);
  else args.push('--all');
  args.push('--limit', String(limit), '--json', '--non-interactive', '--no-color');
  const value = await invoke(args, options);
  if (!Array.isArray(value.deployments)) throw new AxiError('provider-invalid-response', 'Vercel returned a non-list response');
  const items = value.deployments.map(normalizeDeployment);
  const hasNext = value.pagination?.next !== null && value.pagination?.next !== undefined;
  return {
    data: { items },
    meta: { returned: items.length, limit, truncated: hasNext, totalKnown: false, empty: items.length === 0 },
  };
}

export async function deploymentView(deployment, options = {}) {
  validateDeployment(deployment);
  const value = await invoke(['inspect', deployment, '--json', '--non-interactive', '--no-color'], options);
  return { data: normalizeDeployment(value.deployment || value), meta: { empty: false } };
}
