import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createChatServer } from '../chat/http.mjs';

test('HTTP API requires authorization, validates JSON, and streams complete turns', async t => {
  let approvals = 0;
  const session = { id: 'test', messages: [] };
  const service = {
    create: async () => session, status: async () => session,
    send: async (id, message, emit) => { emit({ type: 'text', text: message }); return session; },
    approve: async () => { approvals++; return session; },
  };
  const server = createChatServer({ service, token: 'test-token' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/sessions`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/sessions`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.deepEqual(await (await fetch(`${url}/sessions`, { method: 'POST', headers, body: '{}' })).json(), session);
  const reply = await fetch(`${url}/sessions/test/messages`, { method: 'POST', headers, body: JSON.stringify({ message: 'Hello' }) });
  const events = (await reply.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].text, 'Hello');
  assert.equal(events.at(-1).type, 'done');
  await fetch(`${url}/sessions/test/approve`, { method: 'POST', headers, body: '{"revision":1,"fast":true}' });
  assert.equal(approvals, 1);
  assert.equal((await fetch(`${url}/unknown`, { headers })).status, 404);
});
