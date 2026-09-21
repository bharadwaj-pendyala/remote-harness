import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../chat/agent.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

test('SDK streaming input stays open across turns, resumes by ID, and strips host credentials', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-sdk-test-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let starts = 0;
  let options;
  let capturedSession;
  const queryImpl = input => {
    starts++;
    options = input.options;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-123' };
        for await (const message of input.prompt) {
          assert.equal(message.type, 'user');
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } };
          yield { type: 'result', subtype: 'success', result: 'Hello', session_id: 'sdk-123' };
        }
      },
      close() {},
    };
  };
  const agent = createAgent({
    session: { id: 'test', baseCommit: 'a'.repeat(40), sdkSessionId: 'sdk-existing' },
    dataDir, repository: {}, queryImpl,
    env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'test-token', GH_TOKEN: 'do-not-forward', APP_REPO_TOKEN: 'do-not-forward' },
    onSessionId: id => { capturedSession = id; },
  });
  t.after(() => agent.close());
  const events = [];
  assert.equal((await agent.send('First', event => events.push(event))).text, 'Hello');
  assert.equal((await agent.send('Second', () => {})).text, 'Hello');
  assert.equal(starts, 1);
  assert.equal(capturedSession, 'sdk-123');
  assert.equal(options.resume, 'sdk-existing');
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.env.GH_TOKEN, undefined);
  assert.equal(options.env.APP_REPO_TOKEN, undefined);
  assert.equal(events[0].text, 'Hello');
});

test('SDK error results reject the turn instead of reporting success', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-sdk-error-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const agent = createAgent({ session: { id: 'test', baseCommit: 'a'.repeat(40) }, dataDir, repository: {},
    onSessionId: () => {}, queryImpl: ({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) {
          yield { type: 'result', subtype: 'error_max_turns', errors: ['Turn limit reached'] };
        }
      }, close() {},
    }) });
  t.after(() => agent.close());
  await assert.rejects(agent.send('Question', () => {}), /Turn limit reached/);
});

test('registered MCP tools inspect the pinned source and return a validated draft', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-sdk-tools-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const draft = { spec: { title: 'Add Important', summary: 'Persist a marker', acceptance: ['Survives reload'],
    unchanged: ['List order'], check: 'Reload', journey: 'important-marker', reviewFocus: 'Existing tasks' }, findings: [] };
  const client = new Client({ name: 'test', version: '1.0.0' });
  t.after(() => client.close());
  const source = 'a'.repeat(40);
  const repository = {
    async list(commit) { assert.equal(commit, source); return ['server.js']; },
    async read(commit, path) { assert.equal(commit, source); assert.equal(path, 'server.js'); return 'title, done'; },
    async search(commit, text) { assert.equal(commit, source); assert.equal(text, 'done'); return 'server.js:1:done'; },
  };
  const agent = createAgent({ session: { id: 'test', baseCommit: source }, dataDir, repository, onSessionId: () => {},
    queryImpl: ({ prompt, options }) => ({
      async *[Symbol.asyncIterator]() {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await options.mcpServers.repository.instance.connect(serverTransport);
        await client.connect(clientTransport);
        for await (const message of prompt) {
          const listing = await client.listTools();
          assert.deepEqual(listing.tools.map(item => item.name).sort(), ['list_files', 'propose_spec', 'read_file', 'search_files']);
          assert.match((await client.callTool({ name: 'list_files', arguments: {} })).content[0].text, /server.js/);
          assert.match((await client.callTool({ name: 'read_file', arguments: { path: 'server.js' } })).content[0].text, /title/);
          await client.callTool({ name: 'search_files', arguments: { text: 'done' } });
          const result = await client.callTool({ name: 'propose_spec', arguments: draft });
          assert.notEqual(result.isError, true);
          yield { type: 'result', subtype: 'success', result: 'Review the draft.' };
        }
      }, close() {},
    }) });
  t.after(() => agent.close());
  assert.deepEqual((await agent.send('Draft it', () => {})).draft, draft);
});
