import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiError } from '../src/core/errors.js';
import { execute } from '../src/cli.js';
import {
  githubStatus,
  issueList,
  prChecks,
  prList,
  prReviews,
  prView,
  repoView,
  runFailed,
  runList,
  runView,
} from '../src/adapters/github.js';

const repoPayload = {
  nameWithOwner: 'owner/repo',
  description: 'Repository description',
  visibility: 'PUBLIC',
  url: 'https://github.com/owner/repo',
};

const prPayload = {
  number: 7,
  title: 'Keep argv fixed',
  state: 'OPEN',
  updatedAt: '2026-08-11T10:00:00Z',
};

const issuePayload = {
  number: 9,
  title: 'Keep empty states explicit',
  state: 'OPEN',
  updatedAt: '2026-08-11T11:00:00Z',
};

const ZERO_DATE = '0001-01-01T00:00:00Z';

const prViewPayload = {
  number: 7,
  title: 'Keep argv fixed',
  state: 'OPEN',
  url: 'https://github.com/owner/repo/pull/7',
  author: { login: 'octocat' },
  baseRefName: 'main',
  headRefName: 'feature',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  reviewDecision: 'APPROVED',
  updatedAt: '2026-08-11T10:00:00Z',
};

const runPayload = {
  databaseId: 42,
  workflowName: 'CI',
  displayTitle: 'Keep argv fixed',
  status: 'completed',
  conclusion: 'failure',
  event: 'pull_request',
  headBranch: 'feature',
  headSha: '0123456789abcdef0123456789abcdef01234567',
  attempt: 1,
  number: 19,
  createdAt: '2026-08-11T10:00:00Z',
  startedAt: '2026-08-11T10:00:01Z',
  updatedAt: '2026-08-11T10:02:00Z',
  url: 'https://github.com/owner/repo/actions/runs/42',
};

const jobsPayload = [
  {
    databaseId: 101,
    name: 'test',
    status: 'completed',
    conclusion: 'failure',
    startedAt: '2026-08-11T10:00:02Z',
    completedAt: '2026-08-11T10:01:00Z',
    url: 'https://github.com/owner/repo/actions/runs/42/job/101',
    steps: [
      { name: 'Checkout', number: 1, status: 'completed', conclusion: 'success' },
      { name: 'Test', number: 2, status: 'completed', conclusion: 'failure' },
    ],
  },
  {
    databaseId: 102,
    name: 'lint',
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-08-11T10:00:02Z',
    completedAt: '2026-08-11T10:00:30Z',
    url: 'https://github.com/owner/repo/actions/runs/42/job/102',
    steps: [{ name: 'Lint', number: 1, status: 'completed', conclusion: 'success' }],
  },
];

test('GitHub PR detail, checks, and reviews use exact argv and compact normalized data', async () => {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[1] === 'checks') {
      return {
        code: 8,
        stdout: JSON.stringify([{ name: 'CI', state: 'PENDING', bucket: 'pending', workflow: 'CI', link: 'https://github.com/owner/repo/actions/runs/42', startedAt: '2026-08-11T10:00:00Z', completedAt: null }]),
        stderr: 'provider-secret',
      };
    }
    if (args[args.length - 1] === 'reviews,reviewDecision') {
      return {
        code: 0,
        stdout: JSON.stringify({
          reviewDecision: 'CHANGES_REQUESTED',
          reviews: [
            { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-08-11T10:03:00Z', body: 'secret body' },
            { author: { login: 'approver' }, state: 'APPROVED', submittedAt: '2026-08-11T10:04:00Z', body: 'secret body' },
          ],
        }),
        stderr: '',
      };
    }
    return { code: 0, stdout: JSON.stringify(prViewPayload), stderr: '' };
  };

  const detail = await prView('owner/repo', 7, { runner });
  const checks = await prChecks('owner/repo', 7, { runner });
  const reviews = await prReviews(undefined, 7, 1, { runner });

  assert.deepEqual(detail, {
    data: {
      number: 7,
      title: 'Keep argv fixed',
      state: 'open',
      url: 'https://github.com/owner/repo/pull/7',
      author: 'octocat',
      base: 'main',
      head: 'feature',
      draft: false,
      mergeState: 'clean',
      reviewDecision: 'approved',
      updatedAt: '2026-08-11T10:00:00Z',
    },
    meta: { empty: false },
  });
  assert.deepEqual(checks, {
    data: { items: [{ name: 'CI', state: 'pending', bucket: 'pending', workflow: 'CI', link: 'https://github.com/owner/repo/actions/runs/42', startedAt: '2026-08-11T10:00:00Z', completedAt: null }] },
    meta: { returned: 1, limit: 100, truncated: false, empty: false },
  });
  assert.deepEqual(reviews, {
    data: { decision: 'changes_requested', reviews: [{ author: 'reviewer', state: 'changes_requested', submittedAt: '2026-08-11T10:03:00Z' }] },
    meta: { returned: 1, limit: 1, truncated: true, totalKnown: true, empty: false },
  });
  assert.equal(JSON.stringify([detail, checks, reviews]).includes('secret'), false);
  assert.deepEqual(calls, [
    { file: 'gh', args: ['pr', 'view', '7', '--repo', 'owner/repo', '--json', 'number,title,state,url,author,baseRefName,headRefName,isDraft,mergeStateStatus,reviewDecision,updatedAt'], options: { timeoutMs: 15_000, maxBytes: 512_000 } },
    { file: 'gh', args: ['pr', 'checks', '7', '--repo', 'owner/repo', '--json', 'name,state,bucket,workflow,link,startedAt,completedAt'], options: { timeoutMs: 15_000, maxBytes: 512_000 } },
    { file: 'gh', args: ['pr', 'view', '7', '--json', 'reviews,reviewDecision'], options: { timeoutMs: 15_000, maxBytes: 512_000 } },
  ]);
});

test('GitHub workflow run APIs use exact argv, normalize jobs, and omit logs and successful failures', async () => {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[1] === 'list') return { code: 0, stdout: JSON.stringify([runPayload]), stderr: '' };
    if (args[args.length - 1] === 'jobs') return { code: 0, stdout: JSON.stringify({ jobs: jobsPayload }), stderr: 'secret log' };
    return { code: 0, stdout: JSON.stringify({ ...runPayload, jobs: jobsPayload }), stderr: '' };
  };

  const runs = await runList('owner/repo', 5, { runner });
  const detail = await runView(undefined, 42, { runner });
  const failed = await runFailed('owner/repo', 42, { runner });

  assert.equal(runs.data.items[0].id, 42);
  assert.equal(runs.data.items[0].headSha, runPayload.headSha);
  assert.deepEqual(runs.meta, { returned: 1, limit: 5, truncated: false, totalKnown: false, empty: false });
  assert.equal(detail.data.id, 42);
  assert.equal(detail.data.jobs.length, 2);
  assert.deepEqual(detail.data.jobs[0], {
    id: 101,
    name: 'test',
    status: 'completed',
    conclusion: 'failure',
    startedAt: '2026-08-11T10:00:02Z',
    completedAt: '2026-08-11T10:01:00Z',
    url: 'https://github.com/owner/repo/actions/runs/42/job/101',
  });
  assert.deepEqual(failed, {
    data: {
      jobs: [{ name: 'test', status: 'completed', conclusion: 'failure', steps: [{ name: 'Test', number: 2, status: 'completed', conclusion: 'failure' }] }],
      jobCount: 1,
      stepCount: 1,
    },
    meta: {
      returned: 1,
      empty: false,
      jobsReturned: 1,
      jobsLimit: 100,
      jobsTruncated: false,
      stepsReturned: 1,
      stepsPerJobLimit: 100,
      stepsTruncated: false,
    },
  });
  assert.equal(JSON.stringify([detail, failed]).includes('secret'), false);
  assert.deepEqual(calls, [
    { file: 'gh', args: ['run', 'list', '--repo', 'owner/repo', '--limit', '6', '--json', 'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url'], options: { timeoutMs: 15_000, maxBytes: 512_000 } },
    { file: 'gh', args: ['run', 'view', '42', '--json', 'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,attempt,number,createdAt,startedAt,updatedAt,url,jobs'], options: { timeoutMs: 15_000, maxBytes: 512_000 } },
    { file: 'gh', args: ['run', 'view', '42', '--repo', 'owner/repo', '--json', 'jobs'], options: { timeoutMs: 15_000, maxBytes: 512_000 } },
  ]);
});

test('GitHub normalizes zero-date sentinels across optional check and workflow dates', async () => {
  const checks = await prChecks(undefined, 7, {
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify([{
        name: 'Incomplete external context',
        state: 'PENDING',
        bucket: 'pending',
        workflow: null,
        link: null,
        startedAt: ZERO_DATE,
        completedAt: ZERO_DATE,
      }]),
      stderr: '',
    }),
  });
  const detail = await runView(undefined, 42, {
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        ...runPayload,
        startedAt: ZERO_DATE,
        jobs: [{
          ...jobsPayload[0],
          startedAt: ZERO_DATE,
          completedAt: ZERO_DATE,
        }],
      }),
      stderr: '',
    }),
  });

  assert.equal(checks.data.items[0].startedAt, null);
  assert.equal(checks.data.items[0].completedAt, null);
  assert.equal(detail.data.startedAt, null);
  assert.equal(detail.data.jobs[0].startedAt, null);
  assert.equal(detail.data.jobs[0].completedAt, null);
});

test('GitHub accepts nullable pull request and review authors and submitted dates', async () => {
  const detail = await prView(undefined, 7, {
    runner: async () => ({ code: 0, stdout: JSON.stringify({ ...prViewPayload, author: null }), stderr: '' }),
  });
  const reviews = await prReviews(undefined, 7, 2, {
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({
        reviewDecision: null,
        reviews: [
          { author: null, state: 'COMMENTED', submittedAt: null },
          { author: null, state: 'APPROVED', submittedAt: ZERO_DATE },
        ],
      }),
      stderr: '',
    }),
  });

  assert.equal(detail.data.author, null);
  assert.deepEqual(reviews.data.reviews, [
    { author: null, state: 'commented', submittedAt: null },
    { author: null, state: 'approved', submittedAt: null },
  ]);
});

test('GitHub still rejects malformed non-null authors and review dates', async () => {
  await assert.rejects(
    () => prView(undefined, 7, {
      runner: async () => ({ code: 0, stdout: JSON.stringify({ ...prViewPayload, author: {} }), stderr: '' }),
    }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => prReviews(undefined, 7, 1, {
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({ reviewDecision: null, reviews: [{ author: 'invalid', state: 'COMMENTED', submittedAt: null }] }),
        stderr: '',
      }),
    }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => prReviews(undefined, 7, 1, {
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({ reviewDecision: null, reviews: [{ author: null, state: 'COMMENTED', submittedAt: 'not-a-date' }] }),
        stderr: '',
      }),
    }),
    (error) => error.code === 'provider-invalid-response',
  );
});

test('GitHub expanded APIs enforce identifiers, limits, malformed shapes, empty states, and sanitized failures', async () => {
  let calls = 0;
  const countingRunner = async () => { calls += 1; return { code: 0, stdout: '{}', stderr: '' }; };
  for (const invalidId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', '--help']) {
    await assert.rejects(() => prView(undefined, invalidId, { runner: countingRunner }), (error) => error.code === 'invalid-pr-number');
    await assert.rejects(() => runView(undefined, invalidId, { runner: countingRunner }), (error) => error.code === 'invalid-run-id');
  }
  for (const invalidLimit of [0, 101, '1']) {
    await assert.rejects(() => prReviews(undefined, 1, invalidLimit, { runner: countingRunner }), (error) => error.code === 'invalid-limit');
    await assert.rejects(() => runList(undefined, invalidLimit, { runner: countingRunner }), (error) => error.code === 'invalid-limit');
  }
  assert.equal(calls, 0);

  const emptyChecks = await prChecks(undefined, 1, { runner: async () => ({ code: 0, stdout: '[]', stderr: '' }) });
  const emptyFailures = await runFailed(undefined, 1, { runner: async () => ({ code: 0, stdout: '{"jobs":[]}', stderr: '' }) });
  assert.deepEqual(emptyChecks.meta, { returned: 0, limit: 100, truncated: false, empty: true });
  assert.deepEqual(emptyFailures, {
    data: { jobs: [], jobCount: 0, stepCount: 0 },
    meta: {
      returned: 0,
      empty: true,
      jobsReturned: 0,
      jobsLimit: 100,
      jobsTruncated: false,
      stepsReturned: 0,
      stepsPerJobLimit: 100,
      stepsTruncated: false,
    },
  });

  const malformedCases = [
    () => prView(undefined, 1, { runner: async () => ({ code: 0, stdout: '{"number":1}', stderr: '' }) }),
    () => prChecks(undefined, 1, { runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) }),
    () => prReviews(undefined, 1, 1, { runner: async () => ({ code: 0, stdout: '{"reviews":[]}', stderr: '' }) }),
    () => runList(undefined, 1, { runner: async () => ({ code: 0, stdout: '[{}]', stderr: '' }) }),
    () => runView(undefined, 1, { runner: async () => ({ code: 0, stdout: '{"jobs":[]}', stderr: '' }) }),
    () => runFailed(undefined, 1, { runner: async () => ({ code: 0, stdout: '{"jobs":[{}]}', stderr: '' }) }),
  ];
  for (const operation of malformedCases) {
    await assert.rejects(operation, (error) => error.code === 'provider-invalid-response');
  }

  const secret = 'provider-secret-expanded-7391';
  await assert.rejects(
    () => prChecks(undefined, 1, { runner: async () => ({ code: 8, stdout: `not-json-${secret}`, stderr: secret }) }),
    (error) => error.code === 'github-error' && !JSON.stringify(error).includes(secret),
  );
  await assert.rejects(
    () => prChecks(undefined, 1, { runner: async () => ({ code: 8, stdout: '[]', stderr: secret }) }),
    (error) => error.code === 'github-error' && !JSON.stringify(error).includes(secret),
  );
  for (const [state, bucket] of [['FAILURE', 'fail'], ['FAILURE', 'pending'], ['PENDING', 'fail']]) {
    await assert.rejects(
      () => prChecks(undefined, 1, {
        runner: async () => ({
          code: 8,
          stdout: JSON.stringify([{ name: secret, state, bucket, workflow: 'CI', link: 'https://github.com/owner/repo/actions/runs/42', startedAt: null, completedAt: null }]),
          stderr: secret,
        }),
      }),
      (error) => error.code === 'github-error' && !JSON.stringify(error).includes(secret),
    );
  }
  await assert.rejects(
    () => runFailed(undefined, 1, { runner: async () => ({ code: 1, stdout: `{"message":"${secret}"}`, stderr: secret }) }),
    (error) => error.code === 'github-error' && !JSON.stringify(error).includes(secret),
  );
  for (const code of ['provider-timeout', 'provider-output-limit']) {
    await assert.rejects(
      () => runList(undefined, 1, { runner: async () => { throw new AxiError(code, `${secret} bounded`); } }),
      (error) => error.code === code && !JSON.stringify(error).includes(secret),
    );
  }
});

test('GitHub expanded collection results remain bounded when a runner over-returns', async () => {
  const check = { name: 'CI', state: 'PENDING', bucket: 'pending', workflow: 'CI', link: 'https://github.com/owner/repo/actions/runs/42', startedAt: null, completedAt: null };
  const checks = await prChecks(undefined, 1, {
    runner: async () => ({ code: 0, stdout: JSON.stringify(Array.from({ length: 101 }, () => check)), stderr: '' }),
  });
  const runs = await runList(undefined, 1, {
    runner: async () => ({ code: 0, stdout: JSON.stringify([runPayload, { ...runPayload, databaseId: 43 }]), stderr: '' }),
  });
  const manyJobs = Array.from({ length: 101 }, (_, index) => ({
    ...jobsPayload[0],
    databaseId: index + 1,
    name: `Failure job ${index + 1}`,
    steps: [{ name: 'Failure', number: 1, status: 'completed', conclusion: 'failure' }],
  }));
  const detail = await runView(undefined, 42, {
    runner: async () => ({ code: 0, stdout: JSON.stringify({ ...runPayload, jobs: manyJobs }), stderr: '' }),
  });
  const failedJobs = await runFailed(undefined, 42, {
    runner: async () => ({ code: 0, stdout: JSON.stringify({ jobs: manyJobs }), stderr: '' }),
  });
  const manySteps = Array.from({ length: 101 }, (_, index) => ({ name: `Failure ${index + 1}`, number: index + 1, status: 'completed', conclusion: 'failure' }));
  const failedSteps = await runFailed(undefined, 42, {
    runner: async () => ({ code: 0, stdout: JSON.stringify({ jobs: [{ ...jobsPayload[0], steps: manySteps }] }), stderr: '' }),
  });

  assert.equal(checks.data.items.length, 100);
  assert.deepEqual(checks.meta, { returned: 100, limit: 100, truncated: true, empty: false });
  assert.equal(runs.data.items.length, 1);
  assert.deepEqual(runs.meta, { returned: 1, limit: 1, truncated: true, totalKnown: false, empty: false });
  assert.equal(detail.data.jobs.length, 100);
  assert.deepEqual(detail.meta, { empty: false, jobsReturned: 100, jobsLimit: 100, jobsTruncated: true });
  assert.equal(failedJobs.data.jobs.length, 100);
  assert.deepEqual(failedJobs.meta, {
    returned: 100,
    empty: false,
    jobsReturned: 100,
    jobsLimit: 100,
    jobsTruncated: true,
    stepsReturned: 100,
    stepsPerJobLimit: 100,
    stepsTruncated: false,
  });
  assert.equal(failedSteps.data.jobs[0].steps.length, 100);
  assert.equal(failedSteps.data.stepCount, 100);
  assert.deepEqual(failedSteps.meta, {
    returned: 1,
    empty: false,
    jobsReturned: 1,
    jobsLimit: 100,
    jobsTruncated: false,
    stepsReturned: 100,
    stepsPerJobLimit: 100,
    stepsTruncated: true,
  });
});

test('GitHub workflow runs normalize omitted workflow names to null', async () => {
  const { workflowName: _workflowName, ...runWithoutWorkflowName } = runPayload;
  const runs = await runList(undefined, 3, {
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify([
        runWithoutWorkflowName,
        { ...runPayload, databaseId: 43, workflowName: null },
        { ...runPayload, databaseId: 44, workflowName: '' },
      ]),
      stderr: '',
    }),
  });

  assert.deepEqual(runs.data.items.map((run) => run.workflow), [null, null, null]);
  assert.deepEqual(runs.meta, { returned: 3, limit: 3, truncated: false, totalKnown: false, empty: false });
});

test('GitHub active workflow runs, jobs, and steps accept empty conclusions', async () => {
  const activeRun = {
    ...runPayload,
    status: 'in_progress',
    conclusion: '',
    startedAt: null,
  };
  const activeJob = {
    ...jobsPayload[0],
    status: 'in_progress',
    conclusion: '',
    completedAt: null,
    steps: [
      { name: 'Running', number: 1, status: 'in_progress', conclusion: '' },
      { name: 'Failed', number: 2, status: 'completed', conclusion: 'failure' },
    ],
  };

  const runs = await runList(undefined, 1, {
    runner: async () => ({ code: 0, stdout: JSON.stringify([activeRun]), stderr: '' }),
  });
  const detail = await runView(undefined, 42, {
    runner: async () => ({ code: 0, stdout: JSON.stringify({ ...activeRun, jobs: [activeJob] }), stderr: '' }),
  });
  const failed = await runFailed(undefined, 42, {
    runner: async () => ({ code: 0, stdout: JSON.stringify({ jobs: [{ ...activeJob, status: 'completed', conclusion: 'failure' }] }), stderr: '' }),
  });

  assert.equal(runs.data.items[0].conclusion, null);
  assert.equal(detail.data.conclusion, null);
  assert.equal(detail.data.jobs[0].conclusion, null);
  assert.deepEqual(failed.data.jobs[0].steps, [
    { name: 'Failed', number: 2, status: 'completed', conclusion: 'failure' },
  ]);
});

test('GitHub exit 8 accepts stale pending checks only when no fail bucket exists', async () => {
  const secret = 'provider-secret-mixed-checks';
  await assert.rejects(
    () => prChecks(undefined, 7, {
      runner: async () => ({
        code: 8,
        stdout: JSON.stringify([
          { name: 'External context', state: 'STALE', bucket: 'pending', workflow: '', link: '', startedAt: null, completedAt: null },
          { name: 'Unit tests', state: 'FAILURE', bucket: 'fail', workflow: 'CI', link: 'https://github.com/owner/repo/actions/runs/42', startedAt: null, completedAt: null },
        ]),
        stderr: secret,
      }),
    }),
    (error) => error.code === 'github-error' && !JSON.stringify(error).includes(secret),
  );

  const checks = await prChecks(undefined, 7, {
    runner: async () => ({
      code: 8,
      stdout: JSON.stringify([
        { name: 'External context', state: 'STALE', bucket: 'pending', workflow: '', link: '', startedAt: null, completedAt: null },
      ]),
      stderr: secret,
    }),
  });

  assert.deepEqual(checks.data.items, [
    { name: 'External context', state: 'stale', bucket: 'pending', workflow: null, link: null, startedAt: null, completedAt: null },
  ]);
  assert.equal(JSON.stringify(checks).includes(secret), false);
});

test('GitHub checks normalize absent workflow and link while rejecting malformed links', async () => {
  const checks = await prChecks(undefined, 7, {
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify([
        { name: 'Legacy status', state: 'SUCCESS', bucket: 'pass', workflow: '', link: '', startedAt: null, completedAt: null },
        { name: 'No details URL', state: 'SUCCESS', bucket: 'pass', workflow: null, link: null, startedAt: null, completedAt: null },
      ]),
      stderr: '',
    }),
  });

  assert.deepEqual(checks.data.items.map(({ workflow, link }) => ({ workflow, link })), [
    { workflow: null, link: null },
    { workflow: null, link: null },
  ]);
  await assert.rejects(
    () => prChecks(undefined, 7, {
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify([{ name: 'Bad link', state: 'SUCCESS', bucket: 'pass', workflow: null, link: 'not-a-url', startedAt: null, completedAt: null }]),
        stderr: '',
      }),
    }),
    (error) => error.code === 'provider-invalid-response',
  );
});

test('GitHub run list requests one lookahead item and reports truncation honestly', async () => {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    return {
      code: 0,
      stdout: JSON.stringify([
        runPayload,
        { ...runPayload, databaseId: 43 },
        { ...runPayload, databaseId: 44 },
      ]),
      stderr: '',
    };
  };

  const runs = await runList('owner/repo', 2, { runner });
  const maxRuns = await runList(undefined, 100, { runner });

  assert.deepEqual(runs.data.items.map(({ id }) => id), [42, 43]);
  assert.deepEqual(runs.meta, { returned: 2, limit: 2, truncated: true, totalKnown: false, empty: false });
  assert.deepEqual(maxRuns.meta, { returned: 3, limit: 100, truncated: false, totalKnown: false, empty: false });
  assert.deepEqual(calls, [
    { file: 'gh', args: ['run', 'list', '--repo', 'owner/repo', '--limit', '3', '--json', 'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url'], options: { timeoutMs: 15_000, maxBytes: 512_000 } },
    { file: 'gh', args: ['run', 'list', '--limit', '101', '--json', 'databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,createdAt,updatedAt,url'], options: { timeoutMs: 15_000, maxBytes: 512_000 } },
  ]);
  await assert.rejects(
    () => runList(undefined, 1, {
      runner: async () => ({ code: 0, stdout: JSON.stringify([runPayload, {}]), stderr: '' }),
    }),
    (error) => error.code === 'provider-invalid-response',
  );
});

test('GitHub failed run output excludes non-failing conclusions and retains true failures', async () => {
  const conclusions = ['cancelled', 'skipped', 'neutral', 'stale', 'success', '', null];
  const nonFailingJobs = conclusions.map((conclusion, index) => ({
    ...jobsPayload[0],
    databaseId: 200 + index,
    name: `Non-failure ${String(conclusion)}`,
    conclusion,
    steps: [{ name: 'Not failed', number: 1, status: 'completed', conclusion }],
  }));
  const failingJob = {
    ...jobsPayload[0],
    databaseId: 300,
    name: 'Real failures',
    conclusion: 'timed_out',
    steps: [
      { name: 'Cancelled', number: 1, status: 'completed', conclusion: 'cancelled' },
      { name: 'Timed out', number: 2, status: 'completed', conclusion: 'timed_out' },
      { name: 'Action required', number: 3, status: 'completed', conclusion: 'action_required' },
      { name: 'Startup failure', number: 4, status: 'completed', conclusion: 'startup_failure' },
      { name: 'Failure', number: 5, status: 'completed', conclusion: 'failure' },
    ],
  };

  const failed = await runFailed(undefined, 42, {
    runner: async () => ({ code: 0, stdout: JSON.stringify({ jobs: [...nonFailingJobs, failingJob] }), stderr: '' }),
  });

  assert.deepEqual(failed.data.jobs.map(({ name }) => name), ['Real failures']);
  assert.deepEqual(failed.data.jobs[0].steps.map(({ conclusion }) => conclusion), [
    'timed_out',
    'action_required',
    'startup_failure',
    'failure',
  ]);
  assert.deepEqual(failed.meta, {
    returned: 1,
    empty: false,
    jobsReturned: 1,
    jobsLimit: 100,
    jobsTruncated: false,
    stepsReturned: 4,
    stepsPerJobLimit: 100,
    stepsTruncated: false,
  });
});

test('GitHub views use bounded fixed argv and explicit pagination', async () => {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify(repoPayload), stderr: '' };
    if (args[0] === 'pr') return { code: 0, stdout: JSON.stringify([prPayload, { ...prPayload, number: 8 }]), stderr: '' };
    return { code: 0, stdout: '[]', stderr: '' };
  };

  const repo = await repoView('owner/repo', { runner });
  const prs = await prList('owner/repo', 1, { runner });
  const issues = await issueList(undefined, 3, { runner });

  assert.equal(repo.data.name, 'owner/repo');
  assert.deepEqual(prs.data.items, [{ number: 7, title: 'Keep argv fixed', state: 'open', updatedAt: '2026-08-11T10:00:00Z' }]);
  assert.deepEqual(prs.meta, { returned: 1, limit: 1, truncated: true, totalKnown: false, empty: false });
  assert.deepEqual(issues, {
    data: { items: [] },
    meta: { returned: 0, limit: 3, truncated: false, totalKnown: false, empty: true },
  });
  assert.deepEqual(calls, [
    {
      file: 'gh',
      args: ['repo', 'view', '--json', 'nameWithOwner,description,visibility,url', '--', 'owner/repo'],
      options: { timeoutMs: 15_000, maxBytes: 512_000 },
    },
    {
      file: 'gh',
      args: ['pr', 'list', '--state', 'open', '--limit', '2', '--json', 'number,title,state,updatedAt', '--repo', 'owner/repo'],
      options: { timeoutMs: 15_000, maxBytes: 512_000 },
    },
    {
      file: 'gh',
      args: ['issue', 'list', '--state', 'open', '--limit', '4', '--json', 'number,title,state,updatedAt'],
      options: { timeoutMs: 15_000, maxBytes: 512_000 },
    },
  ]);
});

test('GitHub rejects repository and limit injection before provider invocation', async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { code: 0, stdout: '{}', stderr: '' };
  };

  await assert.rejects(() => repoView('--repo=attacker/repo', { runner }), (error) => error.code === 'invalid-repo');
  await assert.rejects(() => prList('owner/repo --json token', 1, { runner }), (error) => error.code === 'invalid-repo');
  await assert.rejects(() => issueList('owner/repo', '1 --json author', { runner }), (error) => error.code === 'invalid-limit');
  assert.equal(calls, 0);
});

test('GitHub rejects valid JSON with incomplete provider shapes', async () => {
  const runnerFor = (value) => async () => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

  await assert.rejects(
    () => repoView(undefined, { runner: runnerFor({ nameWithOwner: 'owner/repo', visibility: 'PUBLIC' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => prList(undefined, 1, { runner: runnerFor([{ number: 1, title: 'Incomplete', state: 'OPEN' }]) }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => issueList(undefined, 1, { runner: runnerFor({ items: [issuePayload] }) }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => prList(undefined, 1, { runner: runnerFor([prPayload, { ...prPayload, updatedAt: null }]) }),
    (error) => error.code === 'provider-invalid-response',
  );
});

test('GitHub provider failures are redacted and bounded failures survive', async () => {
  const secret = 'provider-secret-7391';
  await assert.rejects(
    () => repoView(undefined, {
      runner: async () => ({ code: 1, stdout: `{"message":"${secret}"}`, stderr: secret }),
    }),
    (error) => error.code === 'github-error' && error.details.exitCode === 1 && !JSON.stringify(error).includes(secret),
  );
  await assert.rejects(
    () => repoView(undefined, {
      runner: async () => ({ code: 0, stdout: `not-json-${secret}`, stderr: secret }),
    }),
    (error) => error.code === 'provider-invalid-response' && !JSON.stringify(error).includes(secret),
  );

  for (const code of ['provider-timeout', 'provider-output-limit']) {
    await assert.rejects(
      () => prList(undefined, 1, { runner: async () => { throw new AxiError(code, 'bounded'); } }),
      (error) => error.code === code,
    );
  }
});

test('GitHub auth status is bounded, output-free, unavailable, or degraded', async () => {
  let call;
  const ready = await githubStatus({
    runner: async (file, args, options) => {
      call = { file, args, options };
      return { code: 0, stdout: 'github.com account secret-user', stderr: 'credential-provider secret' };
    },
  });
  assert.deepEqual(call, {
    file: 'gh',
    args: ['auth', 'status', '--active', '--hostname', 'github.com'],
    options: { timeoutMs: 10_000, maxBytes: 64_000 },
  });
  assert.deepEqual(ready, { data: { available: true, authenticated: true }, meta: { empty: false } });
  assert.ok(!JSON.stringify(ready).includes('secret'));

  const signedOut = await githubStatus({
    runner: async () => ({ code: 1, stdout: 'account secret-user', stderr: 'provider secret' }),
  });
  assert.deepEqual(signedOut.data, { available: true, authenticated: false });

  const unavailable = await githubStatus({
    runner: async () => { throw new AxiError('adapter-unavailable', 'missing'); },
  });
  assert.deepEqual(unavailable.data, { available: false, authenticated: false });

  const degraded = await githubStatus({
    runner: async () => { throw new AxiError('provider-timeout', 'secret-provider timed out'); },
  });
  assert.deepEqual(degraded.data, { available: true, authenticated: false, degraded: true });
  assert.ok(!JSON.stringify(degraded).includes('secret-provider'));
});

test('GitHub CLI routing keeps JSON and compact envelopes stable offline', async () => {
  const calls = [];
  const github = {
    status: async () => ({ data: { available: true, authenticated: true }, meta: { empty: false } }),
    repoView: async (repo) => {
      calls.push(['repo', repo]);
      return { data: repoPayload, meta: { empty: false } };
    },
    prList: async (repo, limit) => {
      calls.push(['pr', repo, limit]);
      return { data: { items: [prPayload] }, meta: { returned: 1, limit, truncated: false, totalKnown: false, empty: false } };
    },
    issueList: async (repo, limit) => {
      calls.push(['issue', repo, limit]);
      return { data: { items: [] }, meta: { returned: 0, limit, truncated: false, totalKnown: false, empty: true } };
    },
  };

  const statusCompact = await execute(['github', 'status'], { github });
  assert.equal(statusCompact.exitCode, 0);
  assert.match(statusCompact.output, /command: "github status"/);
  assert.match(statusCompact.output, /authenticated: true/);

  const repo = JSON.parse((await execute(['github', 'repo', 'view', '--repo', 'owner/repo', '--format', 'json'], { github })).output);
  const prs = JSON.parse((await execute(['github', 'pr', 'list', '--repo', 'owner/repo', '--limit', '7', '--format', 'json'], { github })).output);
  const issues = JSON.parse((await execute(['github', 'issue', 'list', '--repo', 'owner/repo', '--limit', '3', '--format', 'json'], { github })).output);

  assert.equal(repo.command, 'github repo view');
  assert.equal(repo.ok, true);
  assert.deepEqual(repo.help, ['github pr list', 'github issue list']);
  assert.equal(prs.command, 'github pr list');
  assert.equal(prs.meta.limit, 7);
  assert.deepEqual(prs.help, ['github pr list --limit 27']);
  assert.equal(issues.command, 'github issue list');
  assert.equal(issues.meta.empty, true);
  assert.deepEqual(issues.help, ['No open issues found']);
  assert.deepEqual(calls, [
    ['repo', 'owner/repo'],
    ['pr', 'owner/repo', 7],
    ['issue', 'owner/repo', 3],
  ]);

  const secret = 'secret-routing-value-7391';
  const invalid = await execute(['github', 'repo', 'view', secret, '--format', 'json'], { github });
  const failure = JSON.parse(invalid.output);
  assert.equal(invalid.exitCode, 2);
  assert.equal(failure.command, 'github repo view');
  assert.equal(invalid.output.includes(secret), false);
});
