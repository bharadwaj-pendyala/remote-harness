import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubPublisher } from '../chat/github.mjs';

const config = { repo: 'example/harness', appRepo: 'example/app', token: 'test-token', ref: 'codex/test', branch: 'harness-state' };
const run = { id: 'run-example', spec: { summary: 'Test' }, baseCommit: 'a'.repeat(40), approval: { specHash: 'test-hash' } };
const response = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status });

test('record and dispatch target the configured repository, branch and workflow ref', async () => {
  const requests = [];
  const publisher = new GitHubPublisher({ ...config, fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    if (url.includes('/variables/APP_REPO')) return response({ value: 'example/app' });
    return options.method === 'POST' ? response(null, 204) : response({}, 201);
  } });
  await publisher.createRun(run);
  await publisher.dispatch(run.id, true);
  const write = requests.find(request => request.method === 'PUT');
  assert.equal(JSON.parse(write.body).branch, 'harness-state');
  assert.deepEqual(JSON.parse(Buffer.from(JSON.parse(write.body).content, 'base64')), run);
  const dispatch = requests.find(request => request.method === 'POST');
  assert.match(dispatch.url, /execute.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(dispatch.body), { ref: 'codex/test', inputs: { run_id: 'run-example', mode: 'execute', fast: 'true' } });
});

test('an existing record is reused only for the same approved spec and base', async () => {
  const publisher = new GitHubPublisher({ ...config, fetchImpl: async (url, options) => {
    if (url.includes('/variables/APP_REPO')) return response({ value: 'example/app' });
    if (options.method === 'PUT') return response({ message: 'already exists' }, 422);
    return response({ content: Buffer.from(JSON.stringify(run)).toString('base64') });
  } });
  await publisher.createRun(run);
  await assert.rejects(publisher.createRun({ ...run, baseCommit: 'b'.repeat(40) }), /different|match/i);
});

test('a mismatched target app stops before creating a record', async () => {
  const publisher = new GitHubPublisher({ ...config, fetchImpl: async () => response({ value: 'example/different' }) });
  await assert.rejects(publisher.createRun(run), /APP_REPO/);
});

test('behavior acceptance preserves the published record and uses its current file SHA', async () => {
  let updated;
  const publisher = new GitHubPublisher({ ...config, fetchImpl: async (url, options) => {
    if (options.method === 'PUT') { updated = JSON.parse(options.body); return response({}); }
    return response({ sha: 'file-version', content: Buffer.from(JSON.stringify({ ...run, state: 'published', pr: 'https://github.com/example/app/pull/1' })).toString('base64') });
  } });
  const accepted = await publisher.acceptRun(run.id);
  assert.equal(updated.sha, 'file-version');
  assert.equal(accepted.state, 'published');
  assert.ok(accepted.accepted.at);
  assert.equal(accepted.pr, 'https://github.com/example/app/pull/1');
});
