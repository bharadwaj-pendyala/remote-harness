import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDispatch, executionAllowed, settleRun } from './execution.mjs';

const { RUN_ID, MODE, RUNS_DIR, GITHUB_OUTPUT, WORK_RESULT, PUBLISH_RESULT } = process.env;
validateDispatch(RUN_ID, MODE);
if (process.argv[2] !== 'validate') {
  const path = join(RUNS_DIR, RUN_ID, 'run.json');
  const run = JSON.parse(readFileSync(path, 'utf8'));
  if (run.id !== RUN_ID) throw new Error('Run identity does not match its record');
  if (process.argv[2] === 'settle') {
    writeFileSync(path, JSON.stringify(settleRun(run, { work: WORK_RESULT, publish: PUBLISH_RESULT }), null, 2));
  } else {
    const allowed = executionAllowed(run, MODE);
    appendFileSync(GITHUB_OUTPUT, `allowed=${allowed}\nbaseCommit=${run.baseCommit}\n`);
    console.log(allowed ? 'Stage authorized by the current record' : `Skipping duplicate or out-of-order ${MODE} at ${run.state}`);
  }
}
