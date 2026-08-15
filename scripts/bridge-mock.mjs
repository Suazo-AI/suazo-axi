#!/usr/bin/env node
// Reference host bridge used only by the offline conformance tests in
// test/bridge.test.js. It speaks the schemas/bridge-message.schema.json
// contract over stdin/stdout and takes a fixed scenario name as its single
// argument.
//
// It lives here rather than under test/ on purpose: the Node test runner treats
// every .js file inside a test directory as a test file, and this one blocks on
// stdin, so discovering it would hang the suite.
import { BRIDGE_VERSION } from '../src/core/bridge.js';

const scenario = process.argv[2] || 'ok';

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(request) {
  const base = { bridge: BRIDGE_VERSION, id: request.id };
  if (scenario === 'invalid-json') {
    process.stdout.write('not json\n');
    return 0;
  }
  if (scenario === 'exit-nonzero') {
    reply({ ...base, ok: true, items: [] });
    return 3;
  }
  if (scenario === 'bad-version') {
    reply({ ...base, bridge: '9.9', ok: true, items: [] });
    return 0;
  }
  if (scenario === 'bad-correlation') {
    reply({ ...base, id: 'not-the-request-id', ok: true, items: [] });
    return 0;
  }
  if (scenario === 'unknown-error-code') {
    reply({ ...base, ok: false, error: { code: 'teapot' } });
    return 0;
  }
  if (scenario === 'unauthenticated') {
    reply({ ...base, ok: false, error: { code: 'unauthenticated', message: 'token secret-value-7391 expired' } });
    return 0;
  }
  if (scenario === 'mutating-capability') {
    reply({ ...base, ok: true, items: [{ resource: 'design', actions: ['list', 'delete'], mutation: true }] });
    return 0;
  }

  if (request.resource === 'bridge' && request.action === 'describe') {
    reply({ ...base, ok: true, items: [{ resource: 'design', actions: ['list', 'view'], mutation: false }] });
    return 0;
  }
  if (request.action === 'list') {
    const limit = request.limit ?? 2;
    const items = [{ reference: 'design-1', title: 'First' }, { reference: 'design-2', title: 'Second' }].slice(0, limit);
    reply({ ...base, ok: true, items, total: 2, truncated: items.length < 2 });
    return 0;
  }
  reply({ ...base, ok: false, error: { code: 'not-found' } });
  return 0;
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    reply({ bridge: BRIDGE_VERSION, id: 'unknown', ok: false, error: { code: 'invalid-request' } });
    process.exitCode = 0;
    return;
  }
  const code = respond(request);
  if (code !== null) process.exitCode = code;
});
