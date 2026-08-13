import test from 'node:test';
import assert from 'node:assert/strict';
import { success, failure } from '../src/core/envelope.js';
import { formatResult } from '../src/core/format.js';
import { parseArgs, positiveInt } from '../src/core/args.js';
import { AxiError } from '../src/core/errors.js';
import { execute } from '../src/cli.js';

test('success and error envelopes are stable', () => {
  const ok = success('demo', { value: 1 });
  assert.deepEqual(Object.keys(ok), ['axi', 'ok', 'command', 'data', 'meta', 'help']);
  const bad = failure('demo', new AxiError('failed', 'Nope'));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.error, { code: 'failed', message: 'Nope', retryable: false, details: {} });
});

test('formatters are deterministic and JSON is parseable', () => {
  const value = success('demo', { items: [{ id: 'a', count: 2 }] });
  assert.deepEqual(JSON.parse(formatResult(value, 'json')), value);
  assert.equal(formatResult(value), formatResult(value));
  assert.match(formatResult(value), /command: "demo"/);
  assert.match(formatResult(value), /  items:\n    - id: "a"\n      count: 2/);
});

test('argument parser validates flags and integers', () => {
  assert.deepEqual(parseArgs(['files', 'list', '--limit', '5']).flags, { limit: '5' });
  assert.equal(parseArgs(['files', 'list', '--root=C:\\safe=a=b']).flags.root, 'C:\\safe=a=b');
  assert.equal(parseArgs(['codex', 'run', '--prompt-file=C:\\safe path\\prompt=a=b.md']).flags['prompt-file'], 'C:\\safe path\\prompt=a=b.md');
  assert.deepEqual(parseArgs(['github', 'pr', 'view', '--number', '7', '--id', '42']).flags, { number: '7', id: '42' });
  assert.equal(positiveInt('5', 'limit', 20), 5);
  assert.throws(() => positiveInt('0', 'limit', 20), /positive integer/);
  assert.throws(() => parseArgs(['--mystery']), /Unknown flag/);
});

test('invalid command returns structured exit code 2', async () => {
  const result = await execute(['does-not-exist', '--format', 'json']);
  assert.equal(result.exitCode, 2);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'unknown-command');
});

test('home exposes a stable normalized executable path and durable counts', async () => {
  const first = JSON.parse((await execute(['--format', 'json'])).output);
  const second = JSON.parse((await execute(['--format', 'json'])).output);
  assert.equal(first.data.bin, second.data.bin);
  assert.match(first.data.bin, /\/bin\/suazo-axi\.js$/);
  assert.ok(!first.data.bin.includes('\\'));
  assert.deepEqual(Object.keys(first.data.integrations), ['implemented', 'planned', 'host-bridge-required', 'unconfigured']);
});

test('structured errors use a stable command label without sensitive arguments', async () => {
  const secret = 'customer-secret-token-7391.txt';
  const result = await execute(['files', 'read', secret, 'unexpected', '--format', 'json']);
  assert.equal(result.exitCode, 2);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.command, 'files read');
  assert.ok(!result.output.includes(secret));
});
