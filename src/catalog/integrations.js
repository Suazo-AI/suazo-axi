export const integrations = Object.freeze([
  { id: 'files', domain: 'files', transport: 'node-builtins', phase: 1, status: 'implemented', capabilities: [{ resource: 'files', actions: ['list', 'read', 'find'], mutation: false }] },
  { id: 'github', domain: 'github', transport: 'gh-cli', phase: 1, status: 'implemented', capabilities: [{ resource: 'authentication', actions: ['status'], mutation: false }, { resource: 'repository', actions: ['view'], mutation: false }, { resource: 'pull-request', actions: ['list', 'view', 'checks', 'reviews'], mutation: false }, { resource: 'issue', actions: ['list'], mutation: false }, { resource: 'workflow-run', actions: ['list', 'view', 'failed-summary'], mutation: false }] },
  { id: 'outlook-email', domain: 'email', transport: 'native-connector', phase: 'planned', status: 'host-bridge-required', capabilities: [{ resource: 'message', actions: ['list', 'read', 'search'], mutation: false }] },
  { id: 'notion', domain: 'knowledge', transport: 'ntn-cli', phase: 'planned', status: 'planned', capabilities: [{ resource: 'page', actions: ['search', 'read'], mutation: false }] },
  { id: 'vercel', domain: 'deployments', transport: 'vercel-cli', phase: 2, status: 'implemented', capabilities: [{ resource: 'deployment', actions: ['list', 'view'], mutation: false }] },
  { id: 'supabase', domain: 'database', transport: 'supabase-cli', phase: 3, status: 'implemented', capabilities: [{ resource: 'local-status', actions: ['view'], mutation: false }, { resource: 'project', actions: ['list'], mutation: false }] },
  { id: 'codex', domain: 'agents', transport: 'codex-lean-wrapper', phase: 4, status: 'implemented', capabilities: [{ resource: 'authentication', actions: ['status'], mutation: false }, { resource: 'agent-run', actions: ['run'], mutation: false }] },
  { id: 'firecrawl', domain: 'web', transport: 'firecrawl-cli', phase: 'planned', status: 'planned', capabilities: [{ resource: 'page', actions: ['search', 'scrape'], mutation: false }] },
  { id: 'higgsfield', domain: 'media', transport: 'higgsfield-cli', phase: 'planned', status: 'planned', capabilities: [{ resource: 'generation', actions: ['list', 'view'], mutation: false }] },
  { id: 'stitch', domain: 'design', transport: 'mcp', phase: 'planned', status: 'host-bridge-required', capabilities: [{ resource: 'design', actions: ['list', 'view'], mutation: false }] },
  { id: 'hermes', domain: 'agents', transport: 'mcp', phase: 'planned', status: 'host-bridge-required', capabilities: [{ resource: 'agent-run', actions: ['list', 'view'], mutation: false }] },
  { id: 'browser', domain: 'browser', transport: 'plugin-or-native-connector', phase: 'planned', status: 'host-bridge-required', capabilities: [{ resource: 'page', actions: ['inspect', 'capture'], mutation: false }] },
  { id: 'calendar', domain: 'calendar', transport: 'unconfigured', phase: 'future', status: 'unconfigured', capabilities: [{ resource: 'event', actions: ['list', 'view'], mutation: false }] },
]);

export const defaultFields = Object.freeze(['id', 'domain', 'transport', 'phase', 'status']);
export const catalogFields = Object.freeze([...defaultFields, 'capabilities']);

export function selectIntegrations(fields = defaultFields) {
  return integrations.map((item) => Object.fromEntries(fields.map((field) => [field, item[field]])));
}
