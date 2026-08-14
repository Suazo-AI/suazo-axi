import { AxiError, invalid } from '../core/errors.js';
import { runJsonCli } from '../core/cli-provider.js';
import { runProcess } from '../core/process.js';

const JSON_TIMEOUT_MS = 15_000;
const JSON_OUTPUT_CAP_BYTES = 512_000;
const STATUS_TIMEOUT_MS = 10_000;
const STATUS_OUTPUT_CAP_BYTES = 64_000;
const MAX_LIMIT = 100;
const MAX_JOBS = 100;
const ZERO_DATE = '0001-01-01T00:00:00Z';
const PENDING_CHECK_STATES = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested', 'expected', 'stale']);
const PENDING_WORKFLOW_STATUSES = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested', 'expected']);
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const REPO_FIELDS = 'nameWithOwner,description,visibility,url';
const LIST_FIELDS = 'number,title,state,updatedAt';
const PR_VIEW_FIELDS = 'number,title,state,url,author,baseRefName,headRefName,isDraft,mergeStateStatus,reviewDecision,updatedAt';
const PR_CHECK_FIELDS = 'name,state,bucket,workflow,link,startedAt,completedAt';
const PR_REVIEW_FIELDS = 'reviews,reviewDecision';
const RUN_LIST_FIELDS = 'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url';
const RUN_VIEW_FIELDS = 'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,attempt,number,createdAt,startedAt,updatedAt,url,jobs';
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

function validateIdentifier(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalid(code, `${label} must be a positive safe integer`);
  }
}

function requiredString(value, maxLength = 4_096) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function optionalString(value, maxLength = 4_096) {
  return value === null || requiredString(value, maxLength);
}

function optionalConclusion(value, maxLength = 255) {
  return value === null || value === '' || requiredString(value, maxLength);
}

function validDate(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function optionalDate(value) {
  return value === null || value === ZERO_DATE || validDate(value);
}

function normalizedOptionalDate(value) {
  return value === null || value === ZERO_DATE ? null : value;
}

function normalizedOptionalString(value) {
  return value === null || value === '' ? null : value.toLowerCase();
}

function normalizedNullableValue(value) {
  return value === null || value === '' ? null : value;
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

function sanitizedProviderError(error) {
  if (!(error instanceof AxiError)) return error;
  const details = {};
  if (Number.isSafeInteger(error.details?.exitCode)) details.exitCode = error.details.exitCode;
  if (typeof error.details?.providerCode === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(error.details.providerCode)) {
    details.providerCode = error.details.providerCode;
  }
  if (error.details?.provider === 'github' || error.code.startsWith('provider-') || error.code === 'github-error') {
    details.provider = 'github';
  }
  const messages = {
    'adapter-unavailable': 'gh is unavailable',
    'provider-timeout': 'GitHub command timed out',
    'provider-output-limit': 'GitHub command exceeded the output cap',
    'provider-invalid-response': 'GitHub returned an invalid response',
    'github-error': 'GitHub command failed',
  };
  return new AxiError(error.code, messages[error.code] || 'GitHub command failed', {
    exitCode: error.exitCode,
    retryable: error.retryable,
    details,
  });
}

async function invoke(args, { runner } = {}) {
  try {
    return await runJsonCli({
      provider: 'github',
      file: 'gh',
      args,
      timeoutMs: JSON_TIMEOUT_MS,
      maxBytes: JSON_OUTPUT_CAP_BYTES,
      runner,
    });
  } catch (error) {
    throw sanitizedProviderError(error);
  }
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

function normalizeAuthor(value, resource) {
  if (value === null) return null;
  if (!isPlainObject(value) || !requiredString(value.login, 255)) {
    throw providerInvalid(`GitHub returned an incomplete ${resource}`);
  }
  return value.login;
}

function normalizePrView(value) {
  if (
    !isPlainObject(value)
    || !Number.isSafeInteger(value.number)
    || value.number < 1
    || !requiredString(value.title)
    || !['OPEN', 'CLOSED', 'MERGED'].includes(value.state)
    || !validUrl(value.url)
    || !requiredString(value.baseRefName, 255)
    || !requiredString(value.headRefName, 255)
    || typeof value.isDraft !== 'boolean'
    || !requiredString(value.mergeStateStatus, 255)
    || !(value.reviewDecision === null || typeof value.reviewDecision === 'string')
    || !validDate(value.updatedAt)
  ) {
    throw providerInvalid('GitHub returned an incomplete pull request');
  }
  return {
    number: value.number,
    title: value.title,
    state: value.state.toLowerCase(),
    url: value.url,
    author: normalizeAuthor(value.author, 'pull request author'),
    base: value.baseRefName,
    head: value.headRefName,
    draft: value.isDraft,
    mergeState: value.mergeStateStatus.toLowerCase(),
    reviewDecision: normalizedOptionalString(value.reviewDecision),
    updatedAt: value.updatedAt,
  };
}

function normalizeCheck(value) {
  if (
    !isPlainObject(value)
    || !requiredString(value.name)
    || !requiredString(value.state, 255)
    || !requiredString(value.bucket, 255)
    || !(value.workflow === null || value.workflow === '' || requiredString(value.workflow))
    || !(value.link === null || value.link === '' || validUrl(value.link))
    || !optionalDate(value.startedAt)
    || !optionalDate(value.completedAt)
  ) {
    throw providerInvalid('GitHub returned an incomplete pull request check');
  }
  return {
    name: value.name,
    state: value.state.toLowerCase(),
    bucket: value.bucket.toLowerCase(),
    workflow: normalizedNullableValue(value.workflow),
    link: normalizedNullableValue(value.link),
    startedAt: normalizedOptionalDate(value.startedAt),
    completedAt: normalizedOptionalDate(value.completedAt),
  };
}

function isPendingCheckResponse(output) {
  try {
    const values = JSON.parse(output);
    if (!Array.isArray(values) || values.length === 0) return false;
    const checks = values.map(normalizeCheck);
    const hasFailure = checks.some((check) => check.bucket === 'fail');
    const hasPending = checks.some((check) => check.bucket === 'pending' && PENDING_CHECK_STATES.has(check.state));
    return hasPending && !hasFailure;
  } catch {
    return false;
  }
}

function normalizeReview(value) {
  if (!isPlainObject(value) || !requiredString(value.state, 255) || !optionalDate(value.submittedAt)) {
    throw providerInvalid('GitHub returned an incomplete pull request review');
  }
  return {
    author: normalizeAuthor(value.author, 'pull request review author'),
    state: value.state.toLowerCase(),
    submittedAt: normalizedOptionalDate(value.submittedAt),
  };
}

function appendRepo(args, repo) {
  if (repo) args.push('--repo', repo);
  return args;
}

export async function prView(repo, number, options = {}) {
  validateRepo(repo);
  validateIdentifier(number, 'invalid-pr-number', 'Pull request number');
  const args = appendRepo(['pr', 'view', String(number)], repo);
  args.push('--json', PR_VIEW_FIELDS);
  return { data: normalizePrView(await invoke(args, options)), meta: { empty: false } };
}

export async function prChecks(repo, number, options = {}) {
  validateRepo(repo);
  validateIdentifier(number, 'invalid-pr-number', 'Pull request number');
  const args = appendRepo(['pr', 'checks', String(number)], repo);
  args.push('--json', PR_CHECK_FIELDS);
  const baseRunner = options.runner || runProcess;
  const pendingRunner = async (...runnerArgs) => {
    const result = await baseRunner(...runnerArgs);
    return result.code === 8 && isPendingCheckResponse(result.stdout) ? { ...result, code: 0 } : result;
  };
  const values = await invoke(args, { ...options, runner: pendingRunner });
  if (!Array.isArray(values)) throw providerInvalid('GitHub returned a non-list check response');
  const items = values.map(normalizeCheck).slice(0, MAX_LIMIT);
  return {
    data: { items },
    meta: {
      returned: items.length,
      limit: MAX_LIMIT,
      truncated: values.length > MAX_LIMIT,
      empty: items.length === 0,
    },
  };
}

export async function prReviews(repo, number, limit, options = {}) {
  validateRepo(repo);
  validateIdentifier(number, 'invalid-pr-number', 'Pull request number');
  validateLimit(limit);
  const args = appendRepo(['pr', 'view', String(number)], repo);
  args.push('--json', PR_REVIEW_FIELDS);
  const value = await invoke(args, options);
  if (
    !isPlainObject(value)
    || !Array.isArray(value.reviews)
    || !Object.hasOwn(value, 'reviewDecision')
    || !(value.reviewDecision === null || typeof value.reviewDecision === 'string')
  ) {
    throw providerInvalid('GitHub returned an incomplete pull request review response');
  }
  const normalized = value.reviews.map(normalizeReview);
  const reviews = normalized.slice(0, limit);
  return {
    data: { decision: normalizedOptionalString(value.reviewDecision), reviews },
    meta: {
      returned: reviews.length,
      limit,
      truncated: normalized.length > limit,
      totalKnown: true,
      empty: reviews.length === 0,
    },
  };
}

function normalizeRun(value, detail = false) {
  if (
    !isPlainObject(value)
    || !Number.isSafeInteger(value.databaseId)
    || value.databaseId < 1
    || !(
      value.workflowName === undefined
      || value.workflowName === null
      || (typeof value.workflowName === 'string' && value.workflowName.length <= 4_096)
    )
    || !requiredString(value.displayTitle)
    || !requiredString(value.status, 255)
    || !optionalConclusion(value.conclusion)
    || !requiredString(value.event, 255)
    || !requiredString(value.headBranch, 255)
    || typeof value.headSha !== 'string'
    || !/^[0-9a-f]{40}$/i.test(value.headSha)
    || !validDate(value.createdAt)
    || !validDate(value.updatedAt)
    || !validUrl(value.url)
    || (detail && (!Number.isSafeInteger(value.attempt) || value.attempt < 1))
    || (detail && (!Number.isSafeInteger(value.number) || value.number < 1))
    || (detail && !optionalDate(value.startedAt))
  ) {
    throw providerInvalid('GitHub returned an incomplete workflow run');
  }
  return {
    id: value.databaseId,
    workflow: value.workflowName || null,
    title: value.displayTitle,
    status: value.status.toLowerCase(),
    conclusion: normalizedOptionalString(value.conclusion),
    event: value.event,
    headBranch: value.headBranch,
    headSha: value.headSha,
    ...(detail ? { attempt: value.attempt, number: value.number } : {}),
    createdAt: value.createdAt,
    ...(detail ? { startedAt: normalizedOptionalDate(value.startedAt) } : {}),
    updatedAt: value.updatedAt,
    url: value.url,
  };
}

function normalizeJob(value, includeSteps = false) {
  if (
    !isPlainObject(value)
    || !Number.isSafeInteger(value.databaseId)
    || value.databaseId < 1
    || !requiredString(value.name)
    || !requiredString(value.status, 255)
    || !optionalConclusion(value.conclusion)
    || !optionalDate(value.startedAt)
    || !optionalDate(value.completedAt)
    || !validUrl(value.url)
    || (includeSteps && !Array.isArray(value.steps))
  ) {
    throw providerInvalid('GitHub returned an incomplete workflow job');
  }
  return {
    id: value.databaseId,
    name: value.name,
    status: value.status.toLowerCase(),
    conclusion: normalizedOptionalString(value.conclusion),
    startedAt: normalizedOptionalDate(value.startedAt),
    completedAt: normalizedOptionalDate(value.completedAt),
    url: value.url,
  };
}

function normalizeFailedStep(value) {
  if (
    !isPlainObject(value)
    || !requiredString(value.name)
    || !Number.isSafeInteger(value.number)
    || value.number < 1
    || !(value.status === undefined || optionalString(value.status, 255))
    || !(value.conclusion === undefined || optionalConclusion(value.conclusion))
  ) {
    throw providerInvalid('GitHub returned an incomplete workflow step');
  }
  return {
    name: value.name,
    number: value.number,
    ...(value.status ? { status: value.status.toLowerCase() } : {}),
    conclusion: value.conclusion === undefined ? null : normalizedOptionalString(value.conclusion),
  };
}

function isGenuinelyFailing(value) {
  return FAILING_CONCLUSIONS.has(value.conclusion)
    && !(value.status && PENDING_WORKFLOW_STATUSES.has(value.status));
}

export async function runList(repo, limit, options = {}) {
  validateRepo(repo);
  validateLimit(limit);
  const args = appendRepo(['run', 'list'], repo);
  args.push('--limit', String(limit + 1), '--json', RUN_LIST_FIELDS);
  const values = await invoke(args, options);
  if (!Array.isArray(values)) throw providerInvalid('GitHub returned a non-list workflow response');
  const items = values.map((value) => normalizeRun(value)).slice(0, limit);
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

export async function runView(repo, runId, options = {}) {
  validateRepo(repo);
  validateIdentifier(runId, 'invalid-run-id', 'Workflow run ID');
  const args = appendRepo(['run', 'view', String(runId)], repo);
  args.push('--json', RUN_VIEW_FIELDS);
  const value = await invoke(args, options);
  if (!isPlainObject(value) || !Array.isArray(value.jobs)) {
    throw providerInvalid('GitHub returned an incomplete workflow run');
  }
  const allJobs = value.jobs.map((job) => normalizeJob(job));
  const jobs = allJobs.slice(0, MAX_JOBS);
  return {
    data: { ...normalizeRun(value, true), jobs },
    meta: {
      empty: false,
      jobsReturned: jobs.length,
      jobsLimit: MAX_JOBS,
      jobsTruncated: allJobs.length > MAX_JOBS,
    },
  };
}

export async function runFailed(repo, runId, options = {}) {
  validateRepo(repo);
  validateIdentifier(runId, 'invalid-run-id', 'Workflow run ID');
  const args = appendRepo(['run', 'view', String(runId)], repo);
  args.push('--json', 'jobs');
  const value = await invoke(args, options);
  if (!isPlainObject(value) || !Array.isArray(value.jobs)) {
    throw providerInvalid('GitHub returned an incomplete workflow jobs response');
  }
  const normalizedJobs = value.jobs.map((job) => {
    const summary = normalizeJob(job, true);
    const failedSteps = job.steps
      .map(normalizeFailedStep)
      .filter(isGenuinelyFailing);
    return {
      data: {
        name: summary.name,
        ...(summary.status ? { status: summary.status } : {}),
        ...(summary.conclusion ? { conclusion: summary.conclusion } : {}),
        steps: failedSteps.slice(0, MAX_LIMIT),
      },
      stepsTruncated: failedSteps.length > MAX_LIMIT,
    };
  });
  const failedJobs = normalizedJobs.filter((job) => isGenuinelyFailing(job.data));
  const returnedJobs = failedJobs.slice(0, MAX_JOBS);
  const jobs = returnedJobs.map((job) => job.data);
  const stepCount = jobs.reduce((count, job) => count + job.steps.length, 0);
  return {
    data: { jobs, jobCount: jobs.length, stepCount },
    meta: {
      returned: jobs.length,
      empty: jobs.length === 0,
      jobsReturned: jobs.length,
      jobsLimit: MAX_JOBS,
      jobsTruncated: failedJobs.length > MAX_JOBS,
      stepsReturned: stepCount,
      stepsPerJobLimit: MAX_LIMIT,
      stepsTruncated: returnedJobs.some((job) => job.stepsTruncated),
    },
  };
}
