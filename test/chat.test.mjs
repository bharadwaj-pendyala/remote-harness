import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService } from '../chat/sessions.mjs';

const spec = {
  title: 'Add an Important marker', summary: 'Persist a star on each task.',
  acceptance: ['The marker survives reload.'], unchanged: ['Completion and list order.'],
  check: 'Mark a task, reload, and verify the marker.', journey: 'important-marker',
  reviewFocus: 'Existing tasks start unmarked.',
};

function fixture(t, overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'harness-chat-test-'));
  const calls = { agents: [], records: [], dispatches: [] };
  const options = {
    dataDir, idleMs: 60_000,
    repository: { snapshot: async () => 'a'.repeat(40) },
    createAgent: ({ session, onSessionId }) => {
      const agent = {
        closed: false,
        async send(message, emit) {
          onSessionId(`sdk-${session.id}`);
          emit({ type: 'text', text: 'An answer.' });
          return { text: 'An answer.', draft: message === 'draft' ? { spec, findings: [{ path: 'server.js', note: 'Only title and done exist.' }] } : null };
        },
        close() { agent.closed = true; },
      };
      calls.agents.push(agent);
      return agent;
    },
    publisher: {
      async createRun(run) { calls.records.push(run); },
      async dispatch(runId, fast) { calls.dispatches.push({ runId, fast }); },
      async getRun(id) { return { id, state: 'published', pr: 'https://github.com/example/app/pull/1' }; },
    },
    ...overrides,
  };
  const service = new SessionService(options);
  t.after(() => { service.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { service, calls, options, dataDir };
}

test('questions and follow-ups share one agent and never dispatch Actions', async t => {
  const { service, calls } = fixture(t);
  const session = await service.create();
  const events = [];
  await service.send(session.id, 'Is Important implemented?', e => events.push(e));
  await service.send(session.id, 'Which files did you inspect?', () => {});
  assert.equal(calls.agents.length, 1);
  assert.equal(calls.dispatches.length, 0);
  assert.equal(service.get(session.id).messages.length, 4);
  assert.equal(events[0].text, 'An answer.');
});

test('approval dispatches the exact spec and pinned source only once', async t => {
  const { service, calls } = fixture(t);
  const session = await service.create();
  await service.send(session.id, 'draft', () => {});
  const draft = service.get(session.id);
  await service.approve(session.id, draft.revision, true);
  await service.approve(session.id, draft.revision, true);
  assert.equal(calls.records.length, 1);
  assert.deepEqual(calls.records[0].spec, spec);
  assert.equal(calls.records[0].baseCommit, 'a'.repeat(40));
  assert.equal(calls.records[0].state, 'clarified');
  assert.equal(calls.records[0].approval.revision, draft.revision);
  assert.equal(calls.dispatches.length, 1);
  assert.equal(calls.dispatches[0].fast, true);
  const status = await service.status(session.id);
  assert.equal(status.run.state, 'published');
});

test('a new message invalidates an old draft, and stale approval is rejected', async t => {
  const { service, calls } = fixture(t);
  const session = await service.create();
  await service.send(session.id, 'draft', () => {});
  const first = service.get(session.id).revision;
  await service.send(session.id, 'I want to change the requirements', () => {});
  await assert.rejects(service.approve(session.id, first, true), /spec|draft/i);
  await service.send(session.id, 'draft', () => {});
  await assert.rejects(service.approve(session.id, first, true), /revision/i);
  assert.equal(calls.dispatches.length, 0);
});

test('restart retains transcript, draft, and the explicit SDK session id', async t => {
  const { service, options } = fixture(t);
  const session = await service.create();
  await service.send(session.id, 'draft', () => {});
  service.close();
  const restored = new SessionService(options);
  t.after(() => restored.close());
  assert.equal(restored.get(session.id).sdkSessionId, `sdk-${session.id}`);
  assert.equal(restored.get(session.id).messages.length, 2);
  assert.deepEqual(restored.get(session.id).spec, spec);
  await restored.send(session.id, 'Keep going', () => {});
  assert.equal(restored.get(session.id).messages.length, 4);
});

test('agent failure is visible and cannot approve an invalidated draft', async t => {
  const { service, calls } = fixture(t);
  const session = await service.create();
  await service.send(session.id, 'draft', () => {});
  calls.agents[0].send = async () => { throw new Error('Provider unavailable'); };
  await assert.rejects(service.send(session.id, 'Change it', () => {}), /Provider unavailable/);
  assert.match(service.get(session.id).error, /Provider unavailable/);
  assert.equal(service.get(session.id).busy, false);
  await assert.rejects(service.approve(session.id, 1, true), /spec|draft/i);
});

test('an ambiguous dispatch failure is retained and is never automatically retried', async t => {
  let dispatched = 0;
  const { service, options } = fixture(t, { publisher: {
    createRun: async () => {},
    dispatch: async () => { dispatched++; throw new Error('Connection lost after send'); },
  } });
  const session = await service.create();
  await service.send(session.id, 'draft', () => {});
  await assert.rejects(service.approve(session.id, 1, true), /Connection lost/);
  assert.equal(service.get(session.id).approval.status, 'uncertain');
  service.close();
  const restarted = new SessionService(options);
  t.after(() => restarted.close());
  await assert.rejects(restarted.approve(session.id, 1, true), /uncertain|confirm|dispatch/i);
  assert.equal(dispatched, 1);
});

test('overlapping turns are rejected without replacing the active turn', async t => {
  const { service, calls } = fixture(t);
  const session = await service.create();
  await service.send(session.id, 'Hello', () => {});
  let finish;
  calls.agents[0].send = () => new Promise(resolve => { finish = resolve; });
  const pending = service.send(session.id, 'Another question', () => {});
  await assert.rejects(service.send(session.id, 'Overlapping question', () => {}), /busy|progress/i);
  finish({ text: 'Finished.', draft: null });
  await pending;
  assert.equal(service.get(session.id).messages.at(-1).content, 'Finished.');
});

test('invalid identifiers and empty messages cause no side effects', async t => {
  const { service, calls } = fixture(t);
  assert.throws(() => service.get('../escape'), /session/i);
  const session = await service.create();
  await assert.rejects(service.send(session.id, ' ', () => {}), /message/i);
  await assert.rejects(service.approve(session.id, 0, true), /spec|draft/i);
  assert.equal(calls.agents.length, 0);
});

test('SDK session updates during a follow-up cannot restore an older approvable draft', async t => {
  const { service } = fixture(t);
  const session = await service.create();
  await service.send(session.id, 'draft', () => {});
  await service.send(session.id, 'Change the requirement', () => {
    const current = service.get(session.id);
    assert.equal(current.busy, true);
    assert.equal(current.spec, null);
    assert.equal(current.messages.length, 3);
  });
});

test('behavior acceptance requires an approved run', async t => {
  let accepted;
  const { service } = fixture(t, { publisher: {
    createRun: async () => {}, dispatch: async () => {},
    acceptRun: async id => { accepted = id; return { id, state: 'published' }; },
  } });
  const session = await service.create();
  await assert.rejects(service.accept(session.id), /approved/i);
  await service.send(session.id, 'draft', () => {});
  await service.approve(session.id, 1, true);
  await service.accept(session.id);
  assert.equal(accepted, `run-${session.id}`);
});

test('a record-write failure keeps the reviewed draft available for a safe retry', async t => {
  let attempts = 0;
  const { service } = fixture(t, { publisher: {
    createRun: async () => { if (attempts++ === 0) throw new Error('Record unavailable'); },
    dispatch: async () => {},
  } });
  const session = await service.create();
  await service.send(session.id, 'draft', () => {});
  await assert.rejects(service.approve(session.id, 1, true), /Record unavailable/);
  assert.equal(service.get(session.id).approval, null);
  assert.deepEqual(service.get(session.id).spec, spec);
  await service.approve(session.id, 1, true);
  assert.equal(service.get(session.id).approval.status, 'dispatched');
});

test('a temporary GitHub outage does not hide the saved conversation', async t => {
  const { service } = fixture(t, { publisher: {
    createRun: async () => {}, dispatch: async () => {},
    getRun: async () => { throw new Error('GitHub temporarily unavailable'); },
  } });
  const session = await service.create();
  await service.send(session.id, 'draft', () => {});
  await service.approve(session.id, 1, true);
  const current = await service.status(session.id);
  assert.equal(current.messages.length, 2);
  assert.match(current.statusError, /GitHub temporarily unavailable/);
});
