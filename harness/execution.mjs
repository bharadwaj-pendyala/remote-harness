import { createHash } from 'node:crypto';
import { specSchema } from '../chat/contract.mjs';

export function validateDispatch(id, mode) {
  if (!/^run-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('Invalid run id');
  if (!['answer', 'execute', 'repair'].includes(mode)) throw new Error('Invalid execution mode');
}

export function executionAllowed(run, mode) {
  validateDispatch(run.id, mode);
  if (!/^[a-f0-9]{40}$/.test(run.baseCommit)) throw new Error('Invalid source commit');
  if (mode === 'answer') return run.state === 'clarifying';
  specSchema.parse(run.spec);
  if (run.approval && createHash('sha256').update(JSON.stringify(run.spec)).digest('hex') !== run.approval.specHash) {
    throw new Error('The spec no longer matches the approved revision');
  }
  if (mode === 'execute') return run.state === 'clarified';
  return ['check-failed', 'record-failed', 'review-failed'].includes(run.state) && run.repairsLeft > 0;
}

export function settleRun(run, { work, publish }) {
  let reason;
  if (work !== 'success') reason = 'The worker stage failed; see the workflow log.';
  else if (publish === 'failure' || publish === 'cancelled') reason = 'The publish stage failed; check its log for any branch or PR already created before retrying.';
  else if (['check-failed', 'record-failed', 'review-failed'].includes(run.state) && run.repairsLeft <= 0) reason = 'The repair budget is spent; evidence is retained.';
  if (reason) {
    run.reason = reason;
    run.state = 'stopped';
    run.history.push({ state: 'stopped', at: new Date().toISOString() });
  }
  return run;
}
