import { invalid } from './errors.js';

const VALUE_FLAGS = new Set(['format', 'fields', 'root', 'limit', 'max-chars', 'repo', 'workdir', 'prompt-file', 'cwd', 'timeout-ms', 'effort', 'mode']);
const BOOL_FLAGS = new Set(['full', 'help']);

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') throw invalid('invalid-arguments', 'Raw passthrough is not supported');
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const flag = token.slice(2);
    const equals = flag.indexOf('=');
    const rawName = equals === -1 ? flag : flag.slice(0, equals);
    const inline = equals === -1 ? undefined : flag.slice(equals + 1);
    if (!VALUE_FLAGS.has(rawName) && !BOOL_FLAGS.has(rawName)) {
      throw invalid('unknown-flag', `Unknown flag --${rawName}`, { flag: rawName });
    }
    if (BOOL_FLAGS.has(rawName)) {
      if (inline !== undefined) throw invalid('invalid-flag', `--${rawName} does not take a value`);
      flags[rawName] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw invalid('missing-flag-value', `--${rawName} requires a value`);
    flags[rawName] = value;
  }
  if (flags.format && !['compact', 'json'].includes(flags.format)) {
    throw invalid('invalid-format', '--format must be compact or json', { received: flags.format });
  }
  return { positionals, flags };
}

export function positiveInt(value, name, fallback, { max = 1000 } = {}) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw invalid('invalid-number', `--${name} must be a positive integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw invalid('invalid-number', `--${name} must be at most ${max}`);
  return number;
}

export function assertCount(values, min, max, usage) {
  if (values.length < min || values.length > max) throw invalid('invalid-arguments', `Usage: ${usage}`);
}
