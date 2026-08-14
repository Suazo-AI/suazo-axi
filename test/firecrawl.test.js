import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AxiError } from '../src/core/errors.js';
import {
  firecrawlMap,
  firecrawlSearch,
  firecrawlStatus,
  normalizeMap,
  normalizeSearch,
  normalizeStatus,
  resolveFirecrawlTransport,
  validateLimit,
  validateQuery,
  validateUrl,
} from '../src/adapters/firecrawl.js';

const transportResolver = async () => ({ file: 'provider-bin', prefixArgs: ['fixed-prefix'] });
const result = { title: 'AXI', url: 'https://example.com/axi', description: 'Compact interface', markdown: 'discarded' };

test('Firecrawl search normalizes supported array and envelope variants', () => {
  const expected = { items: [{ title: 'AXI', url: result.url, description: 'Compact interface' }] };
  assert.deepEqual(normalizeSearch([result]), expected);
  assert.deepEqual(normalizeSearch({ success: true, data: [result] }), expected);
  assert.deepEqual(normalizeSearch({ data: { web: [result] } }), expected);
  assert.deepEqual(normalizeSearch({ data: { web: [{ title: null, url: result.url, snippet: 'Snippet' }] } }), {
    items: [{ title: null, url: result.url, description: 'Snippet' }],
  });
});

test('Firecrawl map normalizes supported variants including the installed links envelope', () => {
  const expected = { items: [{ url: result.url }] };
  assert.deepEqual(normalizeMap([result.url]), expected);
  assert.deepEqual(normalizeMap({ success: true, data: [result] }), expected);
  assert.deepEqual(normalizeMap({ data: { web: [result] } }), expected);
  assert.deepEqual(normalizeMap({ success: true, data: { links: [result] } }), expected);
});

test('Firecrawl status and operations keep only whitelisted fields and exact argv', async () => {
  assert.deepEqual(normalizeStatus({ success: true, data: { remainingCredits: 42, planCredits: 100, apiKey: 'secret' } }), {
    available: true, authenticated: true, creditsRemaining: 42,
  });
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    const stdout = args.includes('search') ? '{"success":true,"data":{"web":[]}}' : '{"success":true,"data":{"links":[]}}';
    return { code: 0, stdout, stderr: '' };
  };
  const search = await firecrawlSearch('node esm', 7, { transportResolver, runner });
  const map = await firecrawlMap('https://example.com', 9, { transportResolver, runner });
  assert.deepEqual(calls[0], {
    file: 'provider-bin', args: ['fixed-prefix', 'search', 'node esm', '--limit', '7', '--json'], options: { timeoutMs: 20_000, maxBytes: 512_000 },
  });
  assert.deepEqual(calls[1].args, ['fixed-prefix', 'map', 'https://example.com', '--limit', '9', '--json']);
  assert.equal(search.meta.empty, true);
  assert.equal(map.meta.empty, true);
  assert.equal(search.meta.limit, 7);
  assert.equal(map.meta.limit, 9);
});

test('Firecrawl rejects unsupported or incomplete provider shapes and redacts errors', async () => {
  for (const value of [{}, { success: false, data: [] }, { data: { images: [] } }, { success: true, data: {} }]) {
    assert.throws(() => normalizeSearch(value), (error) => error.code === 'provider-invalid-response');
  }
  assert.throws(() => normalizeMap({ links: [] }), (error) => error.code === 'provider-invalid-response');
  assert.throws(() => normalizeSearch([{ title: 'missing URL' }]), (error) => error.code === 'provider-invalid-response');
  const secret = 'firecrawl-secret-7391';
  await assert.rejects(
    () => firecrawlSearch('safe', 10, { transportResolver, runner: async () => ({ code: 5, stdout: secret, stderr: secret }) }),
    (error) => error.code === 'firecrawl-error' && !JSON.stringify(error).includes(secret),
  );
});

test('Firecrawl validates query, URL, and limits before invoking the runner', async () => {
  let called = false;
  const options = { transportResolver, runner: async () => { called = true; return { code: 0, stdout: '[]', stderr: '' }; } };
  await assert.rejects(() => firecrawlSearch('', 10, options), (error) => error.code === 'invalid-query');
  // The query is a positional argument to `firecrawl search`, so a leading hyphen reaches the
  // provider CLI as a flag. Verified end to end before this guard existed: `--query "-h"` made
  // firecrawl print its help instead of searching, and the `--` separator did not stop it.
  for (const injected of ['-h', '--api-url', '-k']) {
    await assert.rejects(() => firecrawlSearch(injected, 10, options), (error) => error.code === 'invalid-query');
  }
  await assert.rejects(() => firecrawlMap('file:///etc/passwd', 10, options), (error) => error.code === 'invalid-url');
  await assert.rejects(() => firecrawlMap(`https://example.com/${'x'.repeat(2050)}`, 10, options), (error) => error.code === 'invalid-url');
  assert.doesNotThrow(() => validateQuery('safe'));
  assert.doesNotThrow(() => validateUrl('http://localhost:3000/path'));
  for (const limit of [0, 101, 1.5, '10']) assert.throws(() => validateLimit(limit), /integer from 1 to 100/);
  assert.equal(called, false);
});

test('Firecrawl transport handles Windows shims, direct binaries, and absence', async () => {
  const entry = path.join('C:\\npm', 'node_modules', 'firecrawl-cli', 'dist', 'index.js');
  for (const extension of ['cmd', 'ps1']) {
    assert.deepEqual(await resolveFirecrawlTransport({
      platform: 'win32', resolver: async () => `C:\\npm\\firecrawl.${extension}`, fileExists: async (file) => file === entry, nodePath: 'node.exe',
    }), { file: 'node.exe', prefixArgs: [entry], source: 'node-cli' });
  }
  assert.deepEqual(await resolveFirecrawlTransport({ platform: 'win32', resolver: async () => 'C:\\bin\\firecrawl.exe' }), {
    file: 'C:\\bin\\firecrawl.exe', prefixArgs: [], source: 'direct-cli',
  });
  assert.deepEqual(await resolveFirecrawlTransport({ platform: 'linux', resolver: async () => '/usr/bin/firecrawl' }), {
    file: '/usr/bin/firecrawl', prefixArgs: [], source: 'direct-cli',
  });
  await assert.rejects(() => resolveFirecrawlTransport({ resolver: async () => null }), (error) => error.code === 'adapter-unavailable');
  await assert.rejects(
    () => resolveFirecrawlTransport({ platform: 'win32', resolver: async () => 'C:\\npm\\firecrawl.cmd', fileExists: async () => false }),
    (error) => error.code === 'adapter-unavailable',
  );
});

test('Firecrawl status distinguishes authenticated, unavailable, authentication-required, and degraded', async () => {
  const ready = await firecrawlStatus({ transportResolver, runner: async () => ({ code: 0, stdout: '{"success":true,"data":{"remainingCredits":3}}', stderr: '' }) });
  assert.deepEqual(ready.data, { available: true, authenticated: true, creditsRemaining: 3 });
  const unavailable = await firecrawlStatus({ transportResolver: async () => { throw new AxiError('adapter-unavailable', 'missing'); } });
  assert.deepEqual(unavailable.data, { available: false, authenticated: false, creditsRemaining: null });
  const auth = await firecrawlStatus({ transportResolver, runner: async () => ({ code: 1, stdout: '{}', stderr: '' }) });
  assert.deepEqual(auth.data, { available: true, authenticated: false, creditsRemaining: null });
  const degraded = await firecrawlStatus({ transportResolver, runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) });
  assert.deepEqual(degraded.data, { available: true, authenticated: false, creditsRemaining: null, degraded: true });
});
