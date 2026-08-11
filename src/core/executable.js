import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

const WINDOWS_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD'];

async function isExecutable(candidate, platform) {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    await fs.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

function pathValue(env, name) {
  const key = Object.keys(env).find((item) => item.toUpperCase() === name);
  return key ? env[key] : undefined;
}

export async function resolveExecutable(command, { env = process.env, platform = process.platform } = {}) {
  if (!command || path.basename(command) !== command) return null;
  const pathEntries = String(pathValue(env, 'PATH') || '').split(path.delimiter).filter(Boolean);
  const hasExtension = path.extname(command) !== '';
  const extensions = platform === 'win32' && !hasExtension
    ? String(pathValue(env, 'PATHEXT') || WINDOWS_EXTENSIONS.join(';')).split(';').filter(Boolean)
    : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${command}${extension}`);
      if (await isExecutable(candidate, platform)) return fs.realpath(candidate);
    }
  }
  return null;
}
