import { AxiError, invalid } from '../core/errors.js';
import { runJsonCli } from '../core/cli-provider.js';
import { runProcess } from '../core/process.js';

const JSON_TIMEOUT_MS = 15_000;
const JSON_OUTPUT_CAP_BYTES = 512_000;
const STATUS_TIMEOUT_MS = 10_000;
const STATUS_OUTPUT_CAP_BYTES = 64_000;
const MAX_LIMIT = 100;
const REPO_FIELDS = 'nameWithOwner,description,visibility,url';
const LIST_FIELDS = 'number,title,state,updatedAt';
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/;

function providerInvalid(message) {
  return new AxiError('provider-invalid-response', message, {
    retryable: true,
    details: { provider: 'github' },
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateRepo(repo) {
  if (repo === undefined) return;
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) {
    throw invalid('invalid-repo', '--repo must be owner/name and cannot start with an option');
  }
}

export function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalid('invalid-limit', `--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
}

function validUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function normalizeRepo(value) {
  if (
    !isPlainObject(value)
    || typeof value.nameWithOwner !== 'string'
    || !REPO_PATTERN.test(value.nameWithOwner)
    || (value.description !== null && typeof value.description !== 'string')
    || !['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(value.visibility)
    || !validUrl(value.url)
  ) {
    throw providerInvalid('GitHub returned an incomplete repository');
  }
  return {
    name: value.nameWithOwner,
    description: value.description || null,
    visibility: value.visibility.toLowerCase(),
    url: value.url,
  };
}

function normalizeListItem(value, states, resource) {
  if (
    !isPlainObject(value)
    || !Number.isInteger(value.number)
    || value.number < 1
    || typeof value.title !== 'string'
    || value.title.length === 0
    || !states.includes(value.state)
    || typeof value.updatedAt !== 'string'
    || Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw providerInvalid(`GitHub returned an incomplete ${resource}`);
  }
  return {
    number: value.number,
    title: value.title,
    state: value.state.toLowerCase(),
    updatedAt: value.updatedAt,
  };
}

export function normalizePr(value) {
  return normalizeListItem(value, ['OPEN', 'CLOSED', 'MERGED'], 'pull request');
}

export function normalizeIssue(value) {
  return normalizeListItem(value, ['OPEN', 'CLOSED'], 'issue');
}

function invoke(args, { runner } = {}) {
  return runJsonCli({
    provider: 'github',
    file: 'gh',
    args,
    timeoutMs: JSON_TIMEOUT_MS,
    maxBytes: JSON_OUTPUT_CAP_BYTES,
    runner,
  });
}

export async function githubStatus({ runner = runProcess } = {}) {
  try {
    const result = await runner('gh', ['auth', 'status', '--active', '--hostname', 'github.com'], {
      timeoutMs: STATUS_TIMEOUT_MS,
      maxBytes: STATUS_OUTPUT_CAP_BYTES,
    });
    return {
      data: { available: true, authenticated: result.code === 0 },
      meta: { empty: false },
    };
  } catch (error) {
    if (error.code === 'adapter-unavailable') {
      return { data: { available: false, authenticated: false }, meta: { empty: false } };
    }
    return {
      data: { available: true, authenticated: false, degraded: true },
      meta: { empty: false },
    };
  }
}

export async function repoView(repo, options = {}) {
  validateRepo(repo);
  const args = ['repo', 'view', '--json', REPO_FIELDS];
  if (repo) args.push('--', repo);
  return { data: normalizeRepo(await invoke(args, options)), meta: { empty: false } };
}

async function list(kind, repo, limit, normalize, options) {
  validateRepo(repo);
  validateLimit(limit);
  const args = [kind, 'list', '--state', 'open', '--limit', String(limit + 1), '--json', LIST_FIELDS];
  if (repo) args.push('--repo', repo);
  const values = await invoke(args, options);
  if (!Array.isArray(values)) throw providerInvalid('GitHub returned a non-list response');
  const normalized = values.map(normalize);
  const items = normalized.slice(0, limit);
  return {
    data: { items },
    meta: {
      returned: items.length,
      limit,
      truncated: values.length > limit,
      totalKnown: false,
      empty: items.length === 0,
    },
  };
}

export const prList = (repo, limit, options = {}) => list('pr', repo, limit, normalizePr, options);
export const issueList = (repo, limit, options = {}) => list('issue', repo, limit, normalizeIssue, options);
