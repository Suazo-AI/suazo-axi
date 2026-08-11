import { AxiError, invalid } from '../core/errors.js';
import { runProcess } from '../core/process.js';

export function validateRepo(repo) {
  if (repo === undefined) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(repo)) throw invalid('invalid-repo', '--repo must be owner/name and cannot start with an option');
}

function parseJson(output) {
  try { return JSON.parse(output); } catch {
    throw new AxiError('provider-invalid-response', 'GitHub returned invalid JSON', { retryable: true });
  }
}

async function gh(args) {
  const result = await runProcess('gh', args);
  if (result.code !== 0) throw new AxiError('github-error', 'GitHub command failed', { retryable: true, details: { exitCode: result.code } });
  return result.stdout;
}

export async function githubStatus() {
  try {
    const result = await runProcess('gh', ['auth', 'status']);
    return { data: { available: true, authenticated: result.code === 0 }, meta: { empty: false } };
  } catch (error) {
    if (error.code === 'adapter-unavailable') return { data: { available: false, authenticated: false }, meta: { empty: false } };
    throw error;
  }
}

export function normalizeRepo(value) {
  return {
    name: value.nameWithOwner,
    description: value.description || null,
    visibility: String(value.visibility || '').toLowerCase(),
    url: value.url,
  };
}

export function normalizePr(value) {
  return { number: value.number, title: value.title, state: String(value.state).toLowerCase(), updatedAt: value.updatedAt };
}

export function normalizeIssue(value) {
  return { number: value.number, title: value.title, state: String(value.state).toLowerCase(), updatedAt: value.updatedAt };
}

export async function repoView(repo) {
  validateRepo(repo);
  const args = ['repo', 'view', '--json', 'nameWithOwner,description,visibility,url'];
  if (repo) args.push('--', repo);
  return { data: normalizeRepo(parseJson(await gh(args))), meta: { empty: false } };
}

async function list(kind, repo, limit, normalize) {
  validateRepo(repo);
  const args = [kind, 'list', '--limit', String(limit), '--json', 'number,title,state,updatedAt'];
  if (repo) args.push('--repo', repo);
  const values = parseJson(await gh(args));
  if (!Array.isArray(values)) throw new AxiError('provider-invalid-response', 'GitHub returned a non-list response');
  const items = values.map(normalize);
  return {
    data: { items },
    meta: {
      returned: items.length,
      limit,
      truncated: items.length === limit,
      totalKnown: false,
      empty: items.length === 0,
    },
  };
}

export const prList = (repo, limit) => list('pr', repo, limit, normalizePr);
export const issueList = (repo, limit) => list('issue', repo, limit, normalizeIssue);
