import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateDispatch, executionAllowed, settleRun } from '../harness/execution.mjs';

const spec = { title: 'Test', summary: 'Test', acceptance: ['Test'], unchanged: [], check: 'Test', journey: 'important-marker', reviewFocus: 'Test' };
const record = () => ({ id: 'run-example-123', state: 'clarified', spec, baseCommit: 'a'.repeat(40), history: [], repairsLeft: 0,
  approval: { specHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex') } });

test('only an unchanged approved spec at the right state can execute', () => {
  assert.equal(executionAllowed(record(), 'execute'), true);
  assert.equal(executionAllowed({ ...record(), state: 'published' }, 'execute'), false);
  assert.throws(() => executionAllowed({ ...record(), spec: { ...spec, summary: 'Changed' } }, 'execute'), /approved/i);
  assert.throws(() => executionAllowed({ ...record(), baseCommit: '--help' }, 'execute'), /commit/i);
  assert.throws(() => executionAllowed({ ...record(), approval: null, spec: { ...spec, journey: 'a;touch /tmp/invalid' } }, 'execute'));
});

test('legacy answer and repair stages retain their state contracts', () => {
  assert.equal(executionAllowed({ ...record(), state: 'clarifying' }, 'answer'), true);
  assert.equal(executionAllowed({ ...record(), state: 'check-failed', repairsLeft: 1 }, 'repair'), true);
  assert.equal(executionAllowed({ ...record(), state: 'check-failed', repairsLeft: 0 }, 'repair'), false);
  assert.throws(() => validateDispatch('run-a"; echo invalid', 'execute'), /run id/i);
  assert.throws(() => validateDispatch('run-example', 'publish'), /mode/i);
});

test('spent repair budget and stage failure become visible terminal states', () => {
  const failed = { ...record(), state: 'check-failed' };
  assert.equal(settleRun(failed, { work: 'success', publish: 'skipped' }).state, 'stopped');
  assert.match(failed.reason, /budget/);
  const broken = settleRun(record(), { work: 'failure', publish: 'skipped' });
  assert.equal(broken.state, 'stopped');
  const publishFailed = settleRun({ ...record(), state: 'reviewed' }, { work: 'success', publish: 'failure' });
  assert.match(publishFailed.reason, /publish/);
  const published = { ...record(), state: 'published' };
  assert.equal(settleRun(published, { work: 'success', publish: 'success' }).state, 'published');
});
