import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { integrations, defaultFields, selectIntegrations } from '../src/catalog/integrations.js';
import { normalizeRepo, normalizePr, normalizeIssue, validateRepo } from '../src/adapters/github.js';

test('catalog has unique ids and honest status categories', () => {
  assert.equal(new Set(integrations.map((item) => item.id)).size, integrations.length);
  assert.ok(integrations.every((item) => ['implemented', 'planned', 'host-bridge-required', 'unconfigured'].includes(item.status)));
  assert.equal(integrations.find((item) => item.id === 'calendar').status, 'unconfigured');
  assert.equal(integrations.find((item) => item.id === 'outlook-email').status, 'host-bridge-required');
  assert.deepEqual(integrations.find((item) => item.id === 'codex'), {
    id: 'codex',
    domain: 'agents',
    transport: 'codex-lean-wrapper',
    phase: 4,
    status: 'implemented',
    capabilities: [
      { resource: 'authentication', actions: ['status'], mutation: false },
      { resource: 'agent-run', actions: ['run'], mutation: false },
    ],
  });
  assert.deepEqual(Object.keys(selectIntegrations(['id', 'status'])[0]), ['id', 'status']);
});

test('catalog aligns with manifest required fields and capability shape', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../schemas/service-manifest.schema.json', import.meta.url), 'utf8'));
  const statuses = schema.properties.status.enum;
  for (const item of integrations) {
    assert.deepEqual(Object.keys(item).sort(), [...schema.required].sort());
    assert.ok(statuses.includes(item.status));
    assert.ok(Array.isArray(item.capabilities) && item.capabilities.length > 0);
    for (const capability of item.capabilities) {
      assert.deepEqual(Object.keys(capability).sort(), [...schema.properties.capabilities.items.required].sort());
      assert.ok(capability.actions.length > 0);
      assert.equal(typeof capability.mutation, 'boolean');
    }
  }
});

test('capabilities are selectable without expanding compact defaults', () => {
  assert.ok(!defaultFields.includes('capabilities'));
  const selected = selectIntegrations(['id', 'capabilities']);
  assert.deepEqual(Object.keys(selected[0]), ['id', 'capabilities']);
  assert.ok(selected.every((item) => item.capabilities.length > 0));
});

test('GitHub JSON normalization keeps compact fields', () => {
  assert.deepEqual(normalizeRepo({ nameWithOwner: 'o/r', description: '', visibility: 'PUBLIC', url: 'https://example.invalid/o/r' }), {
    name: 'o/r', description: null, visibility: 'public', url: 'https://example.invalid/o/r',
  });
  assert.deepEqual(Object.keys(normalizePr({ number: 1, title: 'T', state: 'OPEN', updatedAt: '2026-08-11T10:00:00Z' })), ['number', 'title', 'state', 'updatedAt']);
  assert.equal(normalizeIssue({ number: 2, title: 'I', state: 'CLOSED', updatedAt: '2026-08-11T11:00:00Z' }).state, 'closed');
});

test('GitHub repo names are validated before provider invocation', () => {
  assert.doesNotThrow(() => validateRepo('owner/repo.js'));
  assert.throws(() => validateRepo('owner/repo/extra'), /owner\/name/);
  assert.throws(() => validateRepo('-bad'), /owner\/name/);
  assert.throws(() => validateRepo('-b/x'), /cannot start with an option/);
});
