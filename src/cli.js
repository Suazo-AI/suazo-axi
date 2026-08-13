import { parseArgs, positiveInt, assertCount } from './core/args.js';
import { AxiError, invalid } from './core/errors.js';
import { success, failure } from './core/envelope.js';
import { formatResult } from './core/format.js';
import { integrations, defaultFields, catalogFields, selectIntegrations } from './catalog/integrations.js';
import { listFiles, readFile, findFiles } from './adapters/files.js';
import { doctor } from './adapters/doctor.js';
import { githubStatus, repoView, prList, prView, prChecks, prReviews, issueList, runList, runView, runFailed } from './adapters/github.js';
import { deploymentList, deploymentView } from './adapters/vercel.js';
import { supabaseStatus, projectList } from './adapters/supabase.js';
import { codexRun, codexStatus } from './adapters/codex.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT_HELP = [
  'doctor',
  'integrations list [--fields id,domain,...]',
  'files <list|read|find> ...',
  'github <status|repo|pr|issue|run> ...',
  'vercel deployment <list|view> ...',
  'supabase <status|projects list> ...',
  'codex <status|run> ...',
  'help [command]',
];

const HELP = {
  files: ['files list [path] [--root path] [--limit N] [--full]', 'files read <path> [--root path] [--max-chars N] [--full]', 'files find <query> [path] [--root path] [--limit N]'],
  github: [
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
  ],
  vercel: ['vercel deployment list [project] [--limit N]', 'vercel deployment view <deployment-reference>'],
  supabase: ['supabase status [--workdir path]', 'supabase projects list [--limit N]'],
  codex: ['codex status', 'codex run --prompt-file <path> --cwd <dir> [--timeout-ms N] [--effort low|medium|high] [--mode read-only]'],
  integrations: ['integrations list [--fields id,domain,transport,phase,status,capabilities]'],
  doctor: ['doctor [--format json]'],
};

const GITHUB_OPERATIONS = Object.freeze({
  status: githubStatus,
  repoView,
  prList,
  prView,
  prChecks,
  prReviews,
  issueList,
  runList,
  runView,
  runFailed,
});

const CODEX_OPERATIONS = Object.freeze({
  status: codexStatus,
  run: codexRun,
});

function commandHelp(topic) { return HELP[topic] || ROOT_HELP; }

function compactPath(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  const home = path.resolve(os.homedir()).replaceAll('\\', '/');
  return normalized.toLowerCase() === home.toLowerCase()
    ? '~'
    : normalized.toLowerCase().startsWith(`${home.toLowerCase()}/`)
      ? `~/${normalized.slice(home.length + 1)}`
      : normalized;
}

function home() {
  const counts = Object.fromEntries(['implemented', 'planned', 'host-bridge-required', 'unconfigured'].map((status) => [status, integrations.filter((item) => item.status === status).length]));
  const bin = compactPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/suazo-axi.js'));
  return {
    data: { title: 'suazo-axi', runtime: process.version, bin, cwd: compactPath(process.cwd()), integrations: counts },
    meta: { totalIntegrations: integrations.length, empty: false },
    help: ['doctor', 'integrations list', 'files list . --limit 10'],
  };
}

function rejectFlags(flags, allowed) {
  for (const name of Object.keys(flags)) if (!allowed.includes(name) && name !== 'format') throw invalid('invalid-flag', `--${name} is not valid for this command`);
}

function requiredPositiveInt(flags, name) {
  if (flags[name] === undefined) throw invalid('missing-required-flag', `--${name} is required`);
  return positiveInt(flags[name], name, undefined, { max: Number.MAX_SAFE_INTEGER });
}

async function dispatch(positionals, flags, { github = GITHUB_OPERATIONS, codex = CODEX_OPERATIONS } = {}) {
  if (flags.help || positionals[0] === 'help' || positionals[0] === '--help') {
    const topic = positionals[0] === 'help' ? positionals[1] : positionals[0];
    return { command: 'help', data: { usage: commandHelp(topic) }, meta: { empty: false }, help: [] };
  }
  if (positionals.length === 0) {
    rejectFlags(flags, []);
    return { command: 'home', ...home() };
  }
  const [domain, resource, action, ...rest] = positionals;
  if (domain === 'doctor') {
    assertCount(positionals, 1, 1, 'doctor [--format json]');
    rejectFlags(flags, []);
    return { command: 'doctor', ...(await doctor()), help: ['integrations list'] };
  }
  if (domain === 'integrations' && resource === 'list') {
    assertCount(positionals, 2, 2, 'integrations list [--fields ...]');
    rejectFlags(flags, ['fields']);
    const fields = flags.fields ? flags.fields.split(',').map((item) => item.trim()).filter(Boolean) : [...defaultFields];
    if (!fields.length || fields.some((field) => !catalogFields.includes(field))) throw invalid('invalid-fields', `--fields must use: ${catalogFields.join(',')}`);
    const items = selectIntegrations(fields);
    return { command: 'integrations list', data: { items }, meta: { total: items.length, returned: items.length, empty: items.length === 0 }, help: ['doctor'] };
  }
  if (domain === 'files') {
    if (resource === 'list') {
      assertCount(positionals, 2, 3, 'files list [path] [flags]');
      rejectFlags(flags, ['root', 'limit', 'full']);
      const result = await listFiles({ root: flags.root, target: action || '.', limit: positiveInt(flags.limit, 'limit', 50, { max: 1000 }), full: Boolean(flags.full) });
      return { command: 'files list', ...result, help: ['files read <path>', 'files find <query>'] };
    }
    if (resource === 'read') {
      assertCount(positionals, 3, 3, 'files read <path> [flags]');
      rejectFlags(flags, ['root', 'max-chars', 'full']);
      const result = await readFile({ root: flags.root, target: action, maxChars: positiveInt(flags['max-chars'], 'max-chars', 12_000, { max: 10_000_000 }), full: Boolean(flags.full) });
      return { command: 'files read', ...result, help: ['files list .'] };
    }
    if (resource === 'find') {
      assertCount(positionals, 3, 4, 'files find <query> [path] [flags]');
      rejectFlags(flags, ['root', 'limit']);
      const result = await findFiles({ root: flags.root, query: action, target: rest[0] || '.', limit: positiveInt(flags.limit, 'limit', 50, { max: 1000 }) });
      return { command: 'files find', ...result, help: result.meta.empty ? ['Try a shorter query or a broader path'] : ['files read <path>'] };
    }
    throw invalid('unknown-command', 'Unknown files command', { next: commandHelp('files') });
  }
  if (domain === 'github') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'github status');
      rejectFlags(flags, []);
      return { command: 'github status', ...(await github.status()), help: ['github repo view'] };
    }
    if (resource === 'repo' && action === 'view') {
      assertCount(positionals, 3, 3, 'github repo view [--repo owner/name]');
      rejectFlags(flags, ['repo']);
      return { command: 'github repo view', ...(await github.repoView(flags.repo)), help: ['github pr list', 'github issue list'] };
    }
    if ((resource === 'pr' || resource === 'issue') && action === 'list') {
      assertCount(positionals, 3, 3, `github ${resource} list [flags]`);
      rejectFlags(flags, ['repo', 'limit']);
      const limit = positiveInt(flags.limit, 'limit', 20, { max: 100 });
      const result = resource === 'pr' ? await github.prList(flags.repo, limit) : await github.issueList(flags.repo, limit);
      return { command: `github ${resource} list`, ...result, help: result.meta.empty ? [`No open ${resource === 'pr' ? 'pull requests' : 'issues'} found`] : [`github ${resource} list --limit ${Math.min(limit + 20, 100)}`] };
    }
    if (resource === 'pr' && ['view', 'checks', 'reviews'].includes(action)) {
      assertCount(positionals, 3, 3, `github pr ${action} --number N [flags]`);
      rejectFlags(flags, action === 'reviews' ? ['repo', 'number', 'limit'] : ['repo', 'number']);
      const number = requiredPositiveInt(flags, 'number');
      if (action === 'view') {
        return { command: 'github pr view', ...(await github.prView(flags.repo, number)), help: ['github pr checks --number N', 'github pr reviews --number N'] };
      }
      if (action === 'checks') {
        return { command: 'github pr checks', ...(await github.prChecks(flags.repo, number)), help: ['github pr reviews --number N'] };
      }
      const limit = positiveInt(flags.limit, 'limit', 20, { max: 100 });
      const result = await github.prReviews(flags.repo, number, limit);
      return { command: 'github pr reviews', ...result, help: result.meta.empty ? ['No pull request reviews found'] : ['github pr checks --number N'] };
    }
    if (resource === 'run' && action === 'list') {
      assertCount(positionals, 3, 3, 'github run list [--repo owner/name] [--limit N]');
      rejectFlags(flags, ['repo', 'limit']);
      const limit = positiveInt(flags.limit, 'limit', 20, { max: 100 });
      const result = await github.runList(flags.repo, limit);
      return { command: 'github run list', ...result, help: result.meta.empty ? ['No workflow runs found'] : ['github run view --id N'] };
    }
    if (resource === 'run' && ['view', 'failed'].includes(action)) {
      assertCount(positionals, 3, 3, `github run ${action} --id N [--repo owner/name]`);
      rejectFlags(flags, ['repo', 'id']);
      const runId = requiredPositiveInt(flags, 'id');
      const result = action === 'view'
        ? await github.runView(flags.repo, runId)
        : await github.runFailed(flags.repo, runId);
      return { command: `github run ${action}`, ...result, help: [action === 'view' ? 'github run failed --id N' : 'github run view --id N'] };
    }
    throw invalid('unknown-command', 'Unknown GitHub command', { next: commandHelp('github') });
  }
  if (domain === 'vercel' && resource === 'deployment') {
    if (action === 'list') {
      assertCount(positionals, 3, 4, 'vercel deployment list [project] [--limit N]');
      rejectFlags(flags, ['limit']);
      const limit = positiveInt(flags.limit, 'limit', 20, { max: 100 });
      const result = await deploymentList(rest[0], limit);
      return { command: 'vercel deployment list', ...result, help: result.meta.empty ? ['No deployments found'] : ['vercel deployment view <deployment-reference>'] };
    }
    if (action === 'view') {
      assertCount(positionals, 4, 4, 'vercel deployment view <deployment-reference>');
      rejectFlags(flags, []);
      return { command: 'vercel deployment view', ...(await deploymentView(rest[0])), help: ['vercel deployment list'] };
    }
    throw invalid('unknown-command', 'Unknown Vercel command', { next: commandHelp('vercel') });
  }
  if (domain === 'supabase') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'supabase status [--workdir path]');
      rejectFlags(flags, ['workdir']);
      return { command: 'supabase status', ...(await supabaseStatus(flags.workdir || process.cwd())), help: ['supabase projects list'] };
    }
    if (resource === 'projects' && action === 'list') {
      assertCount(positionals, 3, 3, 'supabase projects list [--limit N]');
      rejectFlags(flags, ['limit']);
      const limit = positiveInt(flags.limit, 'limit', 20, { max: 100 });
      const result = await projectList(limit);
      return { command: 'supabase projects list', ...result, help: result.meta.empty ? ['No accessible projects found'] : ['supabase status --workdir <path>'] };
    }
    throw invalid('unknown-command', 'Unknown Supabase command', { next: commandHelp('supabase') });
  }
  if (domain === 'codex') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'codex status');
      rejectFlags(flags, []);
      return { command: 'codex status', ...(await codex.status()), help: ['codex run --prompt-file <path> --cwd <dir>'] };
    }
    if (resource === 'run') {
      assertCount(positionals, 2, 2, 'codex run --prompt-file <path> --cwd <dir> [flags]');
      rejectFlags(flags, ['prompt-file', 'cwd', 'timeout-ms', 'effort', 'mode']);
      const result = await codex.run({
        promptFile: flags['prompt-file'],
        cwd: flags.cwd,
        timeoutMs: positiveInt(flags['timeout-ms'], 'timeout-ms', 300_000, { max: 1_800_000 }),
        effort: flags.effort || 'medium',
        mode: flags.mode || 'read-only',
      });
      return { command: 'codex run', ...result, help: ['codex status'] };
    }
    throw invalid('unknown-command', 'Unknown Codex command', { next: commandHelp('codex') });
  }
  throw invalid('unknown-command', 'Unknown command', { next: ROOT_HELP });
}

function commandLabel(positionals) {
  if (!positionals.length) return 'home';
  if (positionals[0] === 'help' || positionals[0] === '--help') return 'help';
  if (positionals[0] === 'doctor') return 'doctor';
  if (positionals[0] === 'integrations') return positionals[1] === 'list' ? 'integrations list' : 'integrations';
  if (positionals[0] === 'files') return ['list', 'read', 'find'].includes(positionals[1]) ? `files ${positionals[1]}` : 'files';
  if (positionals[0] === 'github') {
    if (positionals[1] === 'status') return 'github status';
    if (positionals[1] === 'repo' && positionals[2] === 'view') return 'github repo view';
    if (positionals[1] === 'pr' && ['list', 'view', 'checks', 'reviews'].includes(positionals[2])) return `github pr ${positionals[2]}`;
    if (positionals[1] === 'issue' && positionals[2] === 'list') return 'github issue list';
    if (positionals[1] === 'run' && ['list', 'view', 'failed'].includes(positionals[2])) return `github run ${positionals[2]}`;
    return 'github';
  }
  if (positionals[0] === 'vercel') {
    if (positionals[1] === 'deployment' && ['list', 'view'].includes(positionals[2])) return `vercel deployment ${positionals[2]}`;
    return 'vercel';
  }
  if (positionals[0] === 'supabase') {
    if (positionals[1] === 'status') return 'supabase status';
    if (positionals[1] === 'projects' && positionals[2] === 'list') return 'supabase projects list';
    return 'supabase';
  }
  if (positionals[0] === 'codex') {
    if (positionals[1] === 'status') return 'codex status';
    if (positionals[1] === 'run') return 'codex run';
    return 'codex';
  }
  return 'unknown';
}

export async function execute(argv, options = {}) {
  let command = commandLabel(argv);
  let format = 'compact';
  try {
    const parsed = parseArgs(argv);
    command = commandLabel(parsed.positionals);
    format = parsed.flags.format || 'compact';
    const result = await dispatch(parsed.positionals, parsed.flags, options);
    return { exitCode: 0, output: formatResult(success(result.command, result.data, { meta: result.meta, help: result.help }), format) };
  } catch (error) {
    const normalized = error instanceof AxiError ? error : new AxiError('internal-error', 'Unexpected internal error');
    return { exitCode: normalized.exitCode, output: formatResult(failure(command, normalized, commandHelp(command.split(' ')[0])), format) };
  }
}

export async function main(argv) {
  const result = await execute(argv);
  process.stdout.write(result.output);
  return result.exitCode;
}
