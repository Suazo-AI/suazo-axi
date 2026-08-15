import { parseArgs, positiveInt, boundedInt, assertCount } from './core/args.js';
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
import { notionPageView, notionSearch, notionStatus } from './adapters/notion.js';
import { firecrawlMap, firecrawlSearch, firecrawlStatus } from './adapters/firecrawl.js';
import { higgsfieldGenerationList, higgsfieldGenerationView, higgsfieldModelList, higgsfieldStatus } from './adapters/higgsfield.js';
import { composeList, containerList, containerView, dockerStatus, imageList } from './adapters/docker.js';
import { knowledgeAffected, knowledgePath, knowledgeQuery, knowledgeStatus, validateKnowledgeText } from './adapters/knowledge.js';
import { codegraphDeadCode, codegraphStats, codegraphStatus, validateProjectName } from './adapters/codegraph.js';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT_HELP = [
  'doctor',
  'integrations list [--fields id,domain,...]',
  'files <list|read|find> ...',
  'knowledge <status|query|path|affected> ...',
  'codegraph <status|stats|dead-code> ...',
  'github <status|repo|pr|issue|run> ...',
  'vercel deployment <list|view> ...',
  'supabase <status|projects list> ...',
  'notion <status|search|page view> ...',
  'firecrawl <status|search|map> ...',
  'higgsfield <status|model list|generation list|generation view> ...',
  'docker <status|container list|container view|image list|compose list> ...',
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
  notion: ['notion status', 'notion search --query <q> [--limit N]', 'notion page view --id <uuid>'],
  firecrawl: ['firecrawl status', 'firecrawl search --query <q> [--limit N]', 'firecrawl map --url <u> [--limit N]'],
  higgsfield: ['higgsfield status', 'higgsfield model list [--kind image|video|audio|text] [--limit N]', 'higgsfield generation list [--limit N]', 'higgsfield generation view --id <id>'],
  docker: ['docker status', 'docker container list [--all] [--limit N]', 'docker container view --id <id>', 'docker image list [--limit N]', 'docker compose list'],
  codex: ['codex status', 'codex run --prompt-file <path> --cwd <dir> [--timeout-ms N] [--effort low|medium|high] [--mode read-only]'],
  knowledge: ['knowledge status [--graph <graph.json>]', 'knowledge query --question <text> [--graph <graph.json>] [--budget N]', 'knowledge path --from <node> --to <node> [--graph <graph.json>]', 'knowledge affected --node <node> [--graph <graph.json>] [--depth N]'],
  codegraph: ['codegraph status', 'codegraph stats', 'codegraph dead-code --project <name> [--limit N] [--classes]'],
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

const NOTION_OPERATIONS = Object.freeze({ status: notionStatus, search: notionSearch, pageView: notionPageView });
const FIRECRAWL_OPERATIONS = Object.freeze({ status: firecrawlStatus, search: firecrawlSearch, map: firecrawlMap });
const HIGGSFIELD_OPERATIONS = Object.freeze({
  status: higgsfieldStatus,
  modelList: higgsfieldModelList,
  generationList: higgsfieldGenerationList,
  generationView: higgsfieldGenerationView,
});

const DOCKER_OPERATIONS = Object.freeze({
  status: dockerStatus,
  containerList,
  containerView,
  imageList,
  composeList,
});

const KNOWLEDGE_OPERATIONS = Object.freeze({
  status: knowledgeStatus,
  query: knowledgeQuery,
  path: knowledgePath,
  affected: knowledgeAffected,
});

const CODEGRAPH_OPERATIONS = Object.freeze({
  status: codegraphStatus,
  stats: codegraphStats,
  deadCode: codegraphDeadCode,
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

function requiredFlag(flags, name) {
  if (flags[name] === undefined) throw invalid('missing-required-flag', `--${name} is required`);
  return flags[name];
}

async function dispatch(positionals, flags, {
  github = GITHUB_OPERATIONS,
  codex = CODEX_OPERATIONS,
  knowledge = KNOWLEDGE_OPERATIONS,
  codegraph = CODEGRAPH_OPERATIONS,
  notion = NOTION_OPERATIONS,
  firecrawl = FIRECRAWL_OPERATIONS,
  higgsfield = HIGGSFIELD_OPERATIONS,
  docker = DOCKER_OPERATIONS,
} = {}) {
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
  if (domain === 'knowledge') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'knowledge status [--graph <graph.json>]');
      rejectFlags(flags, ['graph']);
      return { command: 'knowledge status', ...(await knowledge.status(flags.graph)), help: ['knowledge query --question <text>'] };
    }
    if (resource === 'query') {
      assertCount(positionals, 2, 2, 'knowledge query --question <text> [flags]');
      rejectFlags(flags, ['question', 'graph', 'budget']);
      validateKnowledgeText(flags.question, 'question');
      const budget = boundedInt(flags.budget, 'budget', 300, { min: 50, max: 2000 });
      return { command: 'knowledge query', ...(await knowledge.query(flags.question, { graph: flags.graph, budget })), help: ['knowledge path --from <node> --to <node>'] };
    }
    if (resource === 'path') {
      assertCount(positionals, 2, 2, 'knowledge path --from <node> --to <node> [flags]');
      rejectFlags(flags, ['from', 'to', 'graph']);
      validateKnowledgeText(flags.from, 'from');
      validateKnowledgeText(flags.to, 'to');
      return { command: 'knowledge path', ...(await knowledge.path(flags.from, flags.to, { graph: flags.graph })), help: ['knowledge affected --node <node>'] };
    }
    if (resource === 'affected') {
      assertCount(positionals, 2, 2, 'knowledge affected --node <node> [flags]');
      rejectFlags(flags, ['node', 'graph', 'depth']);
      validateKnowledgeText(flags.node, 'node');
      const depth = boundedInt(flags.depth, 'depth', 2, { min: 1, max: 6 });
      return { command: 'knowledge affected', ...(await knowledge.affected(flags.node, { graph: flags.graph, depth })), help: ['knowledge query --question <text>'] };
    }
    throw invalid('unknown-command', 'Unknown knowledge command', { next: commandHelp('knowledge') });
  }
  if (domain === 'codegraph') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'codegraph status');
      rejectFlags(flags, []);
      return { command: 'codegraph status', ...(await codegraph.status()), help: ['codegraph stats'] };
    }
    if (resource === 'stats') {
      assertCount(positionals, 2, 2, 'codegraph stats');
      rejectFlags(flags, []);
      return { command: 'codegraph stats', ...(await codegraph.stats()), help: ['codegraph dead-code --project <name>'] };
    }
    if (resource === 'dead-code') {
      assertCount(positionals, 2, 2, 'codegraph dead-code --project <name> [flags]');
      rejectFlags(flags, ['project', 'limit', 'classes']);
      const project = validateProjectName(requiredFlag(flags, 'project'), 'project');
      const limit = boundedInt(flags.limit, 'limit', 50, { min: 1, max: 500 });
      return {
        command: 'codegraph dead-code',
        ...(await codegraph.deadCode(project, { limit, includeClasses: flags.classes === true })),
        help: ['codegraph status'],
      };
    }
    throw invalid('unknown-command', 'Unknown codegraph command', { next: commandHelp('codegraph') });
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
  if (domain === 'notion') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'notion status');
      rejectFlags(flags, []);
      return { command: 'notion status', ...(await notion.status()), help: ['notion search --query <q>'] };
    }
    if (resource === 'search') {
      assertCount(positionals, 2, 2, 'notion search --query <q> [--limit N]');
      rejectFlags(flags, ['query', 'limit']);
      const limit = positiveInt(flags.limit, 'limit', 10, { max: 100 });
      const result = await notion.search(requiredFlag(flags, 'query'), limit);
      return { command: 'notion search', ...result, help: result.meta.empty ? ['No Notion pages found'] : ['notion page view --id <uuid>'] };
    }
    if (resource === 'page' && action === 'view') {
      assertCount(positionals, 3, 3, 'notion page view --id <uuid>');
      rejectFlags(flags, ['id']);
      return { command: 'notion page view', ...(await notion.pageView(requiredFlag(flags, 'id'))), help: ['notion search --query <q>'] };
    }
    throw invalid('unknown-command', 'Unknown Notion command', { next: commandHelp('notion') });
  }
  if (domain === 'firecrawl') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'firecrawl status');
      rejectFlags(flags, []);
      return { command: 'firecrawl status', ...(await firecrawl.status()), help: ['firecrawl search --query <q>'] };
    }
    if (resource === 'search') {
      assertCount(positionals, 2, 2, 'firecrawl search --query <q> [--limit N]');
      rejectFlags(flags, ['query', 'limit']);
      const limit = positiveInt(flags.limit, 'limit', 10, { max: 100 });
      const result = await firecrawl.search(requiredFlag(flags, 'query'), limit);
      return { command: 'firecrawl search', ...result, help: result.meta.empty ? ['No Firecrawl results found'] : ['firecrawl map --url <u>'] };
    }
    if (resource === 'map') {
      assertCount(positionals, 2, 2, 'firecrawl map --url <u> [--limit N]');
      rejectFlags(flags, ['url', 'limit']);
      const limit = positiveInt(flags.limit, 'limit', 100, { max: 100 });
      const result = await firecrawl.map(requiredFlag(flags, 'url'), limit);
      return { command: 'firecrawl map', ...result, help: result.meta.empty ? ['No mapped URLs found'] : ['firecrawl search --query <q>'] };
    }
    throw invalid('unknown-command', 'Unknown Firecrawl command', { next: commandHelp('firecrawl') });
  }
  if (domain === 'higgsfield') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'higgsfield status');
      rejectFlags(flags, []);
      return { command: 'higgsfield status', ...(await higgsfield.status()), help: ['higgsfield model list'] };
    }
    if (resource === 'model' && action === 'list') {
      assertCount(positionals, 3, 3, 'higgsfield model list [--kind image|video|audio|text] [--limit N]');
      rejectFlags(flags, ['kind', 'limit']);
      const limit = positiveInt(flags.limit, 'limit', 10, { max: 100 });
      const result = await higgsfield.modelList(flags.kind, limit);
      return { command: 'higgsfield model list', ...result, help: ['higgsfield generation list'] };
    }
    if (resource === 'generation' && action === 'list') {
      assertCount(positionals, 3, 3, 'higgsfield generation list [--limit N]');
      rejectFlags(flags, ['limit']);
      const limit = positiveInt(flags.limit, 'limit', 10, { max: 100 });
      const result = await higgsfield.generationList(limit);
      return { command: 'higgsfield generation list', ...result, help: result.meta.empty ? ['No Higgsfield generations found'] : ['higgsfield generation view --id <id>'] };
    }
    if (resource === 'generation' && action === 'view') {
      assertCount(positionals, 3, 3, 'higgsfield generation view --id <id>');
      rejectFlags(flags, ['id']);
      return { command: 'higgsfield generation view', ...(await higgsfield.generationView(requiredFlag(flags, 'id'))), help: ['higgsfield generation list'] };
    }
    throw invalid('unknown-command', 'Unknown Higgsfield command', { next: commandHelp('higgsfield') });
  }
  if (domain === 'docker') {
    if (resource === 'status') {
      assertCount(positionals, 2, 2, 'docker status');
      rejectFlags(flags, []);
      return { command: 'docker status', ...(await docker.status()), help: ['docker container list --all'] };
    }
    if (resource === 'container' && action === 'list') {
      assertCount(positionals, 3, 3, 'docker container list [--all] [--limit N]');
      rejectFlags(flags, ['all', 'limit']);
      const limit = positiveInt(flags.limit, 'limit', 20, { max: 100 });
      const result = await docker.containerList({ all: Boolean(flags.all), limit });
      return { command: 'docker container list', ...result, help: result.meta.empty ? ['No containers found'] : ['docker container view --id <id>'] };
    }
    if (resource === 'container' && action === 'view') {
      assertCount(positionals, 3, 3, 'docker container view --id <id>');
      rejectFlags(flags, ['id']);
      return { command: 'docker container view', ...(await docker.containerView(requiredFlag(flags, 'id'))), help: ['docker container list --all'] };
    }
    if (resource === 'image' && action === 'list') {
      assertCount(positionals, 3, 3, 'docker image list [--limit N]');
      rejectFlags(flags, ['limit']);
      const limit = positiveInt(flags.limit, 'limit', 20, { max: 100 });
      const result = await docker.imageList(limit);
      return { command: 'docker image list', ...result, help: result.meta.empty ? ['No images found'] : ['docker container list --all'] };
    }
    if (resource === 'compose' && action === 'list') {
      assertCount(positionals, 3, 3, 'docker compose list');
      rejectFlags(flags, []);
      const result = await docker.composeList();
      return { command: 'docker compose list', ...result, help: result.meta.empty ? ['No Compose projects found'] : ['docker container list --all'] };
    }
    throw invalid('unknown-command', 'Unknown Docker command', { next: commandHelp('docker') });
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
  if (positionals[0] === 'knowledge') return ['status', 'query', 'path', 'affected'].includes(positionals[1]) ? `knowledge ${positionals[1]}` : 'knowledge';
  if (positionals[0] === 'codegraph') return ['status', 'stats', 'dead-code'].includes(positionals[1]) ? `codegraph ${positionals[1]}` : 'codegraph';
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
  if (positionals[0] === 'notion') {
    if (positionals[1] === 'status') return 'notion status';
    if (positionals[1] === 'search') return 'notion search';
    if (positionals[1] === 'page' && positionals[2] === 'view') return 'notion page view';
    return 'notion';
  }
  if (positionals[0] === 'firecrawl') {
    if (positionals[1] === 'status') return 'firecrawl status';
    if (positionals[1] === 'search') return 'firecrawl search';
    if (positionals[1] === 'map') return 'firecrawl map';
    return 'firecrawl';
  }
  if (positionals[0] === 'higgsfield') {
    if (positionals[1] === 'status') return 'higgsfield status';
    if (positionals[1] === 'model' && positionals[2] === 'list') return 'higgsfield model list';
    if (positionals[1] === 'generation' && ['list', 'view'].includes(positionals[2])) return `higgsfield generation ${positionals[2]}`;
    return 'higgsfield';
  }
  if (positionals[0] === 'docker') {
    if (positionals[1] === 'status') return 'docker status';
    if (positionals[1] === 'container' && ['list', 'view'].includes(positionals[2])) return `docker container ${positionals[2]}`;
    if (positionals[1] === 'image' && positionals[2] === 'list') return 'docker image list';
    if (positionals[1] === 'compose' && positionals[2] === 'list') return 'docker compose list';
    return 'docker';
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
