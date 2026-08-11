import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listFiles, readFile, findFiles } from '../src/adapters/files.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-suazo-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('filesystem rejects traversal outside root', async (t) => {
  const root = await fixture(t);
  await assert.rejects(() => listFiles({ root, target: '..' }), (error) => error.code === 'path-outside-root');
});

test('filesystem rejects a symlink or junction escape', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  try { await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('symlink creation is not permitted'); return; }
    throw error;
  }
  await assert.rejects(() => readFile({ root, target: 'escape/secret.txt' }), (error) => error.code === 'path-outside-root');
});

test('read truncates by default and --full escapes truncation', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'long.txt'), 'abcdefghij');
  const short = await readFile({ root, target: 'long.txt', maxChars: 4 });
  assert.equal(short.data.content, 'abcd');
  assert.equal(short.meta.truncated, true);
  const full = await readFile({ root, target: 'long.txt', maxChars: 4, full: true });
  assert.equal(full.data.content, 'abcdefghij');
  assert.equal(full.meta.truncated, false);
});

test('default read bounds bytes before decoding large UTF-8 content', async (t) => {
  const root = await fixture(t);
  const content = '😀'.repeat(50_000);
  await fs.writeFile(path.join(root, 'large.txt'), content);
  const result = await readFile({ root, target: 'large.txt', maxChars: 7 });
  assert.equal(result.data.content, '😀'.repeat(7));
  assert.equal(result.meta.returnedChars, 7);
  assert.equal(result.meta.totalBytes, Buffer.byteLength(content));
  assert.ok(result.meta.readBytes <= (7 * 4) + 4);
  assert.equal(result.meta.truncated, true);
});

test('list and find expose definitive empty states', async (t) => {
  const root = await fixture(t);
  const listed = await listFiles({ root });
  assert.equal(listed.meta.empty, true);
  const found = await findFiles({ root, query: 'missing' });
  assert.deepEqual(found.data.matches, []);
  assert.equal(found.meta.empty, true);
});

test('find is bounded and skips internal research output', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'graphify-out'));
  await fs.writeFile(path.join(root, 'graphify-out', 'needle.txt'), 'hidden');
  await fs.writeFile(path.join(root, 'needle-visible.txt'), 'visible');
  const found = await findFiles({ root, query: 'needle' });
  assert.deepEqual(found.data.matches.map((item) => item.path), ['needle-visible.txt']);
});
