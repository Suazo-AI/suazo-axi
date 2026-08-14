import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AxiError } from '../src/core/errors.js';
import {
  normalizePage,
  normalizeSearch,
  normalizeStatus,
  notionPageView,
  notionSearch,
  notionStatus,
  notionTitle,
  resolveNotionTransport,
  validateLimit,
  validatePageId,
  validateQuery,
} from '../src/adapters/notion.js';

const transportResolver = async () => ({ file: 'provider-bin', prefixArgs: ['fixed-prefix'] });
const pageId = '12345678-1234-1234-1234-123456789abc';
const page = {
  object: 'page',
  id: pageId,
  url: 'https://www.notion.so/Test-123',
  created_time: '2026-08-01T10:00:00.000Z',
  last_edited_time: '2026-08-02T10:00:00.000Z',
  archived: false,
  properties: { title: { title: [{ plain_text: 'Test' }, { plain_text: ' page' }] } },
};

test('Notion pure normalizers keep only compact status, search, and page fields', () => {
  assert.equal(notionTitle(page), 'Test page');
  assert.equal(notionTitle({ properties: { Name: { title: [{ plain_text: 'Named' }] } } }), 'Named');
  assert.equal(notionTitle({ properties: { title: { title: [] } } }), null);
  assert.deepEqual(normalizeStatus({ id: 'bot-id', bot: { workspace_name: 'Workspace' }, token: 'secret' }), {
    available: true, authenticated: true, botId: 'bot-id', workspaceName: 'Workspace',
  });
  assert.deepEqual(normalizeSearch({ results: [page] }), {
    items: [{ id: pageId, title: 'Test page', object: 'page', url: page.url, lastEditedAt: page.last_edited_time }],
  });
  assert.deepEqual(normalizePage(page), {
    id: pageId, title: 'Test page', url: page.url, createdAt: page.created_time, lastEditedAt: page.last_edited_time, archived: false,
  });
});

// Key set captured verbatim from `ntn api /v1/pages/<id>` against the live workspace. The current
// API returns `is_archived` and `in_trash`; `archived` is the legacy name, so a normalizer that
// only reads `archived` rejects every real page while staying green on a legacy fixture.
test('Notion page normalizes the shape the live API actually returns', () => {
  const live = {
    object: 'page',
    id: pageId,
    created_time: '2026-07-22T00:55:00.000Z',
    last_edited_time: '2026-07-22T00:55:00.000Z',
    is_archived: false,
    in_trash: false,
    is_locked: false,
    url: 'https://app.notion.com/p/Jason-Suazo-42aec9bb',
    public_url: null,
    properties: { Name: { title: [{ plain_text: 'Jason Suazo' }] }, Email: { email: 'private@example.com' } },
  };
  const normalized = normalizePage(live);
  assert.deepEqual(normalized, {
    id: pageId,
    title: 'Jason Suazo',
    url: live.url,
    createdAt: live.created_time,
    lastEditedAt: live.last_edited_time,
    archived: false,
  });
  assert.equal(JSON.stringify(normalized).includes('private@example.com'), false);
});

test('Notion search and page view use exact bounded argv and explicit meta', async () => {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: 0, stdout: calls.length === 1 ? '{"results":[]}' : JSON.stringify(page), stderr: '' };
  };
  const empty = await notionSearch('release notes', 7, { transportResolver, runner });
  assert.deepEqual(calls[0], {
    file: 'provider-bin',
    args: ['fixed-prefix', 'api', '/v1/search', '-d', '{"query":"release notes","page_size":7}'],
    options: { timeoutMs: 20_000, maxBytes: 512_000 },
  });
  assert.deepEqual(empty, {
    data: { items: [] },
    meta: { returned: 0, limit: 7, truncated: false, totalKnown: false, empty: true },
  });
  const viewed = await notionPageView(pageId, { transportResolver, runner });
  assert.deepEqual(calls[1].args, ['fixed-prefix', 'api', `/v1/pages/${pageId}`]);
  assert.equal(viewed.data.title, 'Test page');
  assert.deepEqual(viewed.meta, { empty: false });
});

test('Notion rejects invalid inputs before transport invocation', async () => {
  let called = false;
  const options = { transportResolver, runner: async () => { called = true; return { code: 0, stdout: '{}', stderr: '' }; } };
  for (const query of ['', ' '.repeat(3), `bad\0query`, 'x'.repeat(513)]) {
    await assert.rejects(() => notionSearch(query, 10, options), (error) => error.code === 'invalid-query');
  }
  for (const limit of [0, 101, 1.5, '10']) assert.throws(() => validateLimit(limit), /integer from 1 to 100/);
  for (const id of ['--token', 'bad', 'g'.repeat(32)]) assert.throws(() => validatePageId(id), /Notion UUID/);
  assert.doesNotThrow(() => validatePageId('12345678123412341234123456789abc'));
  assert.doesNotThrow(() => validateQuery('safe'));
  assert.equal(called, false);
});

test('Notion rejects incomplete JSON and redacts CLI payloads', async () => {
  await assert.rejects(
    () => notionSearch('safe', 10, { transportResolver, runner: async () => ({ code: 0, stdout: '{"results":[{}]}', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
  await assert.rejects(
    () => notionPageView(pageId, { transportResolver, runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) }),
    (error) => error.code === 'provider-invalid-response',
  );
  const secret = 'notion-secret-7391';
  await assert.rejects(
    () => notionSearch('safe', 10, { transportResolver, runner: async () => ({ code: 9, stdout: secret, stderr: secret }) }),
    (error) => error.code === 'notion-error' && !JSON.stringify(error).includes(secret),
  );
});

test('Notion transport handles Windows shims, native fallback, direct binaries, and absence', async () => {
  const windowsEntry = path.win32.join('C:\\npm', 'node_modules', 'ntn', 'bin', 'ntn');
  assert.deepEqual(await resolveNotionTransport({
    platform: 'win32', resolver: async () => 'C:\\npm\\ntn.cmd', fileExists: async (file) => file === windowsEntry, nodePath: 'node.exe',
  }), { file: 'node.exe', prefixArgs: [windowsEntry], source: 'node-cli' });

  const nativeEntry = path.win32.join('C:\\npm', 'node_modules', 'ntn', 'bin', 'ntn.exe');
  assert.deepEqual(await resolveNotionTransport({
    platform: 'win32', resolver: async () => 'C:\\npm\\ntn.ps1', fileExists: async (file) => file === nativeEntry,
  }), { file: nativeEntry, prefixArgs: [], source: 'native-cli' });
  assert.deepEqual(await resolveNotionTransport({ platform: 'win32', resolver: async () => 'C:\\bin\\ntn.exe' }), {
    file: 'C:\\bin\\ntn.exe', prefixArgs: [], source: 'direct-cli',
  });
  assert.deepEqual(await resolveNotionTransport({ platform: 'linux', resolver: async () => '/usr/bin/ntn' }), {
    file: '/usr/bin/ntn', prefixArgs: [], source: 'direct-cli',
  });
  await assert.rejects(() => resolveNotionTransport({ resolver: async () => null }), (error) => error.code === 'adapter-unavailable');
  await assert.rejects(
    () => resolveNotionTransport({ platform: 'win32', resolver: async () => 'C:\\npm\\ntn.cmd', fileExists: async () => false }),
    (error) => error.code === 'adapter-unavailable',
  );
});

test('Notion status distinguishes authenticated, unavailable, authentication-required, and degraded', async () => {
  const ready = await notionStatus({ transportResolver, runner: async () => ({ code: 0, stdout: '{"id":"bot","bot":{"workspace_name":"AXI"}}', stderr: '' }) });
  assert.deepEqual(ready.data, { available: true, authenticated: true, botId: 'bot', workspaceName: 'AXI' });
  const unavailable = await notionStatus({ transportResolver: async () => { throw new AxiError('adapter-unavailable', 'missing'); } });
  assert.deepEqual(unavailable.data, { available: false, authenticated: false, botId: null, workspaceName: null });
  const auth = await notionStatus({ transportResolver, runner: async () => ({ code: 1, stdout: '{}', stderr: '' }) });
  assert.deepEqual(auth.data, { available: true, authenticated: false, botId: null, workspaceName: null });
  const degraded = await notionStatus({ transportResolver, runner: async () => ({ code: 0, stdout: '{}', stderr: '' }) });
  assert.deepEqual(degraded.data, { available: true, authenticated: false, botId: null, workspaceName: null, degraded: true });
});
