#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const HARNESS_HOME = resolve(import.meta.dirname, '..');
const RUNS_DIR = process.env.RUNS_DIR ?? `${HARNESS_HOME}/runs`;
const RECORD_REPO = process.env.RECORD_REPO;

if (!RECORD_REPO) throw new Error('RECORD_REPO is required, as owner/repo');

const MARKER = '<!-- run.json -->';

const STAKEHOLDER_STATE = {
  clarifying: 'Waiting on you',
  clarified: 'Ready to run',
  prepared: 'Running',
  implemented: 'Running',
  'check-failed': 'Repairing',
  repairing: 'Repairing',
  checked: 'Running',
  recorded: 'Ready to review',
  published: 'Ready to review',
  stopped: 'Stopped',
};

const gh = (args, input) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();

const runPath = (id) => `${RUNS_DIR}/${id}/run.json`;
const issueNumber = (id) => id.replace(/^run-/, '');

function issueBody(run) {
  const lines = [
    `**Request**  ${run.request}`,
    `**State**  ${STAKEHOLDER_STATE[run.state] ?? run.state}  \`${run.state}\``,
    `**Base**  \`${run.baseCommit.slice(0, 7)}\``,
  ];

  if (run.spec) {
    lines.push('', `### Agreed task`, run.spec.summary, ...run.spec.acceptance.map((a) => `- ${a}`));
  }
  if (run.reason) lines.push('', `### Stopped`, run.reason);
  if (run.pr) lines.push('', `### Draft pull request`, run.pr);

  lines.push(
    '',
    `### History`,
    ...run.history.map((h) => `- \`${h.state}\` ${h.at}`),
    '',
    MARKER,
    '```json',
    JSON.stringify(run, null, 2),
    '```',
  );
  return lines.join('\n');
}

function open(request) {
  const url = gh([
    'issue', 'create', '--repo', RECORD_REPO,
    '--title', request.slice(0, 80),
    '--body', `**Request**  ${request}\n\nThe harness has not started this run yet.`,
    '--label', 'harness-run',
  ]);
  const id = `run-${url.split('/').pop()}`;
  console.log(id);
  return id;
}

function push(id) {
  const run = JSON.parse(readFileSync(runPath(id), 'utf8'));
  gh(['issue', 'edit', issueNumber(id), '--repo', RECORD_REPO, '--body-file', '-'], issueBody(run));
  console.log(`record     ${RECORD_REPO}#${issueNumber(id)} is ${run.state}`);
  return run;
}

function pull(id) {
  const body = gh(['issue', 'view', issueNumber(id), '--repo', RECORD_REPO, '--json', 'body', '--jq', '.body']);
  const match = body.split(MARKER)[1]?.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`issue ${id} carries no run record`);

  mkdirSync(`${RUNS_DIR}/${id}`, { recursive: true });
  writeFileSync(runPath(id), match[1]);
  console.log(`pulled     ${id} at ${JSON.parse(match[1]).state}`);
  return JSON.parse(match[1]);
}

function state(id) {
  const run = existsSync(runPath(id)) ? JSON.parse(readFileSync(runPath(id), 'utf8')) : pull(id);
  console.log(run.state);
  return run.state;
}

function comment(id, text) {
  gh(['issue', 'comment', issueNumber(id), '--repo', RECORD_REPO, '--body', text]);
  return text;
}

const { positionals } = parseArgs({ allowPositionals: true });
const [command, ...rest] = positionals;

const commands = {
  open: () => open(rest.join(' ')),
  push: () => push(rest[0]),
  pull: () => pull(rest[0]),
  state: () => state(rest[0]),
  comment: () => comment(rest[0], rest.slice(1).join(' ')),
};

if (!commands[command]) {
  console.log(`usage (RECORD_REPO=<owner/repo>):
  node harness/record.mjs open "<request>"
  node harness/record.mjs push <run-id>
  node harness/record.mjs pull <run-id>
  node harness/record.mjs state <run-id>
  node harness/record.mjs comment <run-id> "<text>"`);
  process.exit(1);
}
commands[command]();
