import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/cli.js';
import { AxiError } from '../src/core/errors.js';

function ok(data = {}, meta = { empty: false }) {
  return { data, meta };
}

function githubFakes(calls = []) {
  return {
    status: async () => ok(),
    repoView: async () => ok(),
    prList: async () => ok({ items: [] }, { empty: true }),
    issueList: async () => ok({ items: [] }, { empty: true }),
    prView: async (repo, number) => { calls.push(['prView', repo, number]); return ok({ number }); },
    prChecks: async (repo, number) => { calls.push(['prChecks', repo, number]); return ok({ items: [] }); },
    prReviews: async (repo, number, limit) => { calls.push(['prReviews', repo, number, limit]); return ok({ items: [{}] }, { empty: false, limit }); },
    runList: async (repo, limit) => { calls.push(['runList', repo, limit]); return ok({ items: [{}] }, { empty: false, limit }); },
    runView: async (repo, runId) => { calls.push(['runView', repo, runId]); return ok({ id: runId }); },
    runFailed: async (repo, runId) => { calls.push(['runFailed', repo, runId]); return ok({ jobs: [] }); },
  };
}

async function json(argv, github) {
  const result = await execute(['--format', 'json', ...argv], { github });
  return { result, envelope: JSON.parse(result.output) };
}

test('expanded GitHub routes forward exact arguments and preserve command labels', async () => {
  const calls = [];
  const github = githubFakes(calls);
  const cases = [
    [['github', 'pr', 'view', '--repo', 'owner/repo', '--number', '41'], 'github pr view'],
    [['github', 'pr', 'checks', '--repo', 'owner/repo', '--number', '42'], 'github pr checks'],
    [['github', 'pr', 'reviews', '--repo', 'owner/repo', '--number', '43'], 'github pr reviews'],
    [['github', 'run', 'list', '--repo', 'owner/repo', '--limit', '7'], 'github run list'],
    [['github', 'run', 'view', '--repo', 'owner/repo', '--id', '9007199254740991'], 'github run view'],
    [['github', 'run', 'failed', '--repo', 'owner/repo', '--id', '55'], 'github run failed'],
  ];

  for (const [argv, command] of cases) {
    const { result, envelope } = await json(argv, github);
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.command, command);
    assert.equal(envelope.ok, true);
  }

  assert.deepEqual(calls, [
    ['prView', 'owner/repo', 41],
    ['prChecks', 'owner/repo', 42],
    ['prReviews', 'owner/repo', 43, 20],
    ['runList', 'owner/repo', 7],
    ['runView', 'owner/repo', 9007199254740991],
    ['runFailed', 'owner/repo', 55],
  ]);
});

test('expanded GitHub help is accurate and compact', async () => {
  const { result, envelope } = await json(['help', 'github'], githubFakes());
  assert.equal(result.exitCode, 0);
  assert.deepEqual(envelope.data.usage, [
    'github status',
    'github repo view [--repo owner/name]',
    'github pr list [--repo owner/name] [--limit N]',
    'github pr view --number N [--repo owner/name]',
    'github pr checks --number N [--repo owner/name]',
    'github pr reviews --number N [--repo owner/name] [--limit N]',
    'github issue list [--repo owner/name] [--limit N]',
    'github run list [--repo owner/name] [--limit N]',
    'github run view --id N [--repo owner/name]',
    'github run failed --id N [--repo owner/name]',
  ]);
});

test('expanded GitHub routes reject invalid flags, identifiers, limits, paths, and extra positionals', async () => {
  const github = githubFakes();
  const cases = [
    [['github', 'pr', 'view'], 'github pr view', 'missing-required-flag'],
    [['github', 'pr', 'view', '--number', '0'], 'github pr view', 'invalid-number'],
    [['github', 'pr', 'checks', '--number', 'nope'], 'github pr checks', 'invalid-number'],
    [['github', 'run', 'view', '--id', '-1'], 'github run view', 'invalid-number'],
    [['github', 'run', 'failed'], 'github run failed', 'missing-required-flag'],
    [['github', 'pr', 'reviews', '--number', '1', '--limit', '101'], 'github pr reviews', 'invalid-number'],
    [['github', 'run', 'list', '--limit', '101'], 'github run list', 'invalid-number'],
    [['github', 'pr', 'view', 'extra', '--number', '1'], 'github pr view', 'invalid-arguments'],
    [['github', 'pr', 'view', '--number', '1', '--limit', '2'], 'github pr view', 'invalid-flag'],
    [['github', 'run', 'logs', '--id', '1'], 'github', 'unknown-command'],
  ];

  for (const [argv, command, code] of cases) {
    const { result, envelope } = await json(argv, github);
    assert.equal(result.exitCode, 2, argv.join(' '));
    assert.equal(envelope.command, command, argv.join(' '));
    assert.equal(envelope.error.code, code, argv.join(' '));
  }
});

test('provider failures retain exact expanded GitHub command labels and exit 1', async () => {
  const routes = [
    [['github', 'pr', 'view', '--number', '1'], 'prView', 'github pr view'],
    [['github', 'pr', 'checks', '--number', '1'], 'prChecks', 'github pr checks'],
    [['github', 'pr', 'reviews', '--number', '1'], 'prReviews', 'github pr reviews'],
    [['github', 'run', 'list'], 'runList', 'github run list'],
    [['github', 'run', 'view', '--id', '1'], 'runView', 'github run view'],
    [['github', 'run', 'failed', '--id', '1'], 'runFailed', 'github run failed'],
  ];

  for (const [argv, operation, command] of routes) {
    const github = githubFakes();
    github[operation] = async () => { throw new AxiError('github-error', 'GitHub operation failed'); };
    const { result, envelope } = await json(argv, github);
    assert.equal(result.exitCode, 1, command);
    assert.equal(envelope.command, command);
    assert.equal(envelope.error.code, 'github-error');
  }
});
