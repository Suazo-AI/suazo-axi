import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AxiError, invalid } from '../core/errors.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.firecrawl', '.codex', 'graphify-out']);

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function realOrResolved(target) {
  try { return await fs.realpath(target); } catch (error) {
    if (error.code === 'ENOENT') return path.resolve(target);
    throw error;
  }
}

export async function resolveSafe(rootInput, targetInput = '.') {
  const root = await realOrResolved(path.resolve(rootInput));
  let rootStat;
  try { rootStat = await fs.stat(root); } catch (error) {
    throw new AxiError('root-unavailable', 'Filesystem root is unavailable', { details: { cause: error.code } });
  }
  if (!rootStat.isDirectory()) throw invalid('invalid-root', '--root must be a directory');
  const candidate = path.resolve(root, targetInput);
  if (!inside(root, candidate)) throw invalid('path-outside-root', 'Path resolves outside the configured root');
  const resolved = await realOrResolved(candidate);
  if (!inside(root, resolved)) throw invalid('path-outside-root', 'Path resolves outside the configured root');
  return { root, target: resolved, relative: path.relative(root, resolved) || '.' };
}

function fileType(entry) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

function identityIsStable(stat) {
  return Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.ino !== 0;
}

async function verifyOpenedPath(root, target, openedStat) {
  let current;
  try { current = await fs.realpath(target); } catch (error) {
    throw new AxiError('path-changed-during-access', 'Path changed while it was being opened', { details: { cause: error.code } });
  }
  if (!inside(root, current)) throw new AxiError('path-changed-during-access', 'Path escaped the configured root while it was being opened');
  const currentStat = await fs.stat(current);
  if (identityIsStable(openedStat) && identityIsStable(currentStat)
      && (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino)) {
    throw new AxiError('path-changed-during-access', 'Path target changed while it was being opened');
  }
  return current;
}

async function openVerifiedFile(safe) {
  let handle;
  try { handle = await fs.open(safe.target, 'r'); } catch (error) {
    throw new AxiError(error.code === 'ENOENT' ? 'path-not-found' : 'filesystem-error', 'Unable to open file', { details: { cause: error.code } });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw invalid('not-a-file', 'Path is not a regular file');
    await verifyOpenedPath(safe.root, safe.target, stat);
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readDirectoryEntries(root, target) {
  let directory;
  try { directory = await fs.opendir(target); } catch (error) {
    throw new AxiError(error.code === 'ENOENT' ? 'path-not-found' : 'filesystem-error', 'Unable to list path', { details: { cause: error.code } });
  }
  try {
    await verifyOpenedPath(root, target, await fs.stat(target));
    const entries = [];
    let entry;
    while ((entry = await directory.read()) !== null) entries.push(entry);
    return entries;
  } finally {
    await directory.close().catch(() => {});
  }
}

function clipCodePoints(value, limit) {
  let count = 0;
  let end = 0;
  let truncated = false;
  for (const character of value) {
    if (count === limit) { truncated = true; break; }
    count += 1;
    end += character.length;
  }
  return { text: value.slice(0, end), count, truncated };
}

function countCodePoints(value) {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

export async function listFiles({ root = process.cwd(), target = '.', limit = 50, full = false }) {
  const safe = await resolveSafe(root, target);
  const entries = await readDirectoryEntries(safe.root, safe.target);
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const selected = full ? entries : entries.slice(0, limit);
  const items = selected.map((entry) => ({ name: entry.name, type: fileType(entry), path: path.join(safe.relative === '.' ? '' : safe.relative, entry.name).replaceAll('\\', '/') }));
  return {
    data: { path: safe.relative.replaceAll('\\', '/'), items },
    meta: { total: entries.length, returned: items.length, truncated: items.length < entries.length, empty: entries.length === 0 },
  };
}

export async function readFile({ root = process.cwd(), target, maxChars = 12_000, full = false }) {
  const safe = await resolveSafe(root, target);
  const { handle, stat } = await openVerifiedFile(safe);
  try {
    let content;
    let readBytes;
    let returnedChars;
    let clipped = false;
    if (full) {
      content = await handle.readFile({ encoding: 'utf8' });
      readBytes = stat.size;
      returnedChars = countCodePoints(content);
    } else {
      const byteLimit = Math.min(stat.size, (maxChars * 4) + 4);
      const buffer = Buffer.alloc(byteLimit);
      const result = await handle.read(buffer, 0, byteLimit, 0);
      readBytes = result.bytesRead;
      const bounded = clipCodePoints(buffer.subarray(0, result.bytesRead).toString('utf8'), maxChars);
      content = bounded.text;
      returnedChars = bounded.count;
      clipped = bounded.truncated;
    }
    const truncated = !full && (readBytes < stat.size || clipped);
    return {
      data: { path: safe.relative.replaceAll('\\', '/'), content },
      meta: { totalBytes: stat.size, readBytes, returnedChars, truncated, empty: stat.size === 0 },
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function findFiles({ root = process.cwd(), target = '.', query, limit = 50 }) {
  const safe = await resolveSafe(root, target);
  const needle = query.toLocaleLowerCase('en');
  const matches = [];
  let scanned = 0;
  let bounded = false;
  const queue = [safe.target];
  const maxEntries = 20_000;
  while (queue.length && matches.length < limit && scanned < maxEntries) {
    const current = queue.shift();
    let entries;
    try { entries = await readDirectoryEntries(safe.root, current); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      scanned += 1;
      if (scanned >= maxEntries) { bounded = true; break; }
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      let resolved;
      try { resolved = await fs.realpath(entryPath); } catch { continue; }
      if (!inside(safe.root, resolved)) continue;
      if (entry.name.toLocaleLowerCase('en').includes(needle)) {
        matches.push({ path: path.relative(safe.root, resolved).replaceAll('\\', '/'), type: fileType(entry) });
        if (matches.length >= limit) break;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(resolved);
    }
  }
  return {
    data: { query, path: safe.relative.replaceAll('\\', '/'), matches },
    meta: { returned: matches.length, scanned, truncated: matches.length >= limit || bounded, empty: matches.length === 0 },
  };
}
