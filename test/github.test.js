import test from 'node:test';
import assert from 'node:assert/strict';
import { AxiError } from '../src/core/errors.js';
import { execute } from '../src/cli.js';
import {
  githubStatus,
  issueList,
  prList,
  repoView,
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
