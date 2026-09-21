#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

const HARNESS_HOME = resolve(import.meta.dirname, '..');
const RUNS_DIR = process.env.RUNS_DIR ?? `${HARNESS_HOME}/runs`;
const RECORD_REPO = process.env.RECORD_REPO;
const BRANCH = process.env.RECORD_BRANCH ?? 'harness-state';
const RETRIES = 4;

if (!RECORD_REPO) throw new Error('RECORD_REPO is required, as owner/repo');

const runPath = (id) => `${RUNS_DIR}/${id}/run.json`;
const headPath = (id) => `${RUNS_DIR}/${id}/.expected-head`;
const remotePath = (id) => `runs/${id}.json`;

function gh(args, input) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      input,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'inherit'],
    }).trim();
  } catch (error) {
    // gh exits non-zero on a GraphQL error, but the body carries why.
    if (error.stdout?.trim().startsWith('{')) return error.stdout.trim();
    throw error;
  }
}

const api = (path, jq) => gh(['api', `repos/${RECORD_REPO}/${path}`, ...(jq ? ['--jq', jq] : [])]);

const branchHead = () => api(`git/ref/heads/${BRANCH}`, '.object.sha');

function graphql(query, variables) {
  const out = gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }));
  const body = JSON.parse(out);
  if (body.errors) {
    throw new Error(body.errors.map((e) => `${e.type ?? 'ERROR'}: ${e.message}`).join('; '));
  }
  return body.data;
}

const COMMIT = `mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

function commit(headline, fileChanges, expectedHead) {
  const { createCommitOnBranch } = graphql(COMMIT, {
    input: {
      branch: { repositoryNameWithOwner: RECORD_REPO, branchName: BRANCH },
      expectedHeadOid: expectedHead,
      message: { headline },
      fileChanges,
    },
  });
  return createCommitOnBranch.commit.oid;
}

function commitRecord(run, expectedHead) {
  const contents = Buffer.from(`${JSON.stringify(run, null, 2)}\n`).toString('base64');
  return commit(`${run.id}: ${run.state}`, { additions: [{ path: remotePath(run.id), contents }] }, expectedHead);
}

function fetchRecord(id) {
  const head = branchHead();
  const encoded = api(`contents/${remotePath(id)}?ref=${head}`, '.content');
  return { run: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')), head };
}

function open(request) {
  const id = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
  const run = { id, request, state: 'queued', history: [], artifacts: {} };

  mkdirSync(`${RUNS_DIR}/${id}`, { recursive: true });
  writeFileSync(runPath(id), JSON.stringify(run, null, 2));
  writeFileSync(headPath(id), commitRecord(run, branchHead()));

  console.log(id);
  return id;
}

function push(id) {
  const run = JSON.parse(readFileSync(runPath(id), 'utf8'));
  let expected = existsSync(headPath(id)) ? readFileSync(headPath(id), 'utf8').trim() : branchHead();

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const oid = commitRecord(run, expected);
      writeFileSync(headPath(id), oid);
      console.log(`record     ${BRANCH} ${oid.slice(0, 7)} is ${run.state}`);
      return run;
    } catch (error) {
      if (attempt === RETRIES || !/STALE_DATA/.test(error.message)) throw error;
      expected = branchHead();
      console.log(`record     head moved, retrying against ${expected.slice(0, 7)}`);
    }
  }
}

function pull(id) {
  const { run, head } = fetchRecord(id);
  mkdirSync(`${RUNS_DIR}/${id}`, { recursive: true });
  writeFileSync(runPath(id), JSON.stringify(run, null, 2));
  writeFileSync(headPath(id), head);
  console.log(`pulled     ${id} at ${run.state}`);
  return run;
}

function list() {
  const names = JSON.parse(api(`contents/runs?ref=${BRANCH}`))
    .map((entry) => entry.name)
    .filter((name) => name.startsWith('run-'));

  const runs = names.map((name) => fetchRecord(name.replace(/\.json$/, '')).run);
  console.log(JSON.stringify(runs, null, 2));
  return runs;
}

function drop(id) {
  const oid = commit(`${id}: dropped`, { deletions: [{ path: remotePath(id) }] }, branchHead());
  console.log(`dropped    ${id} at ${oid.slice(0, 7)}`);
  return oid;
}

function state(id) {
  const run = existsSync(runPath(id)) ? JSON.parse(readFileSync(runPath(id), 'utf8')) : fetchRecord(id).run;
  console.log(run.state);
  return run.state;
}

const { positionals } = parseArgs({ allowPositionals: true });
const [command, ...rest] = positionals;

const commands = {
  open: () => open(rest.join(' ')),
  push: () => push(rest[0]),
  pull: () => pull(rest[0]),
  list: () => list(),
  drop: () => drop(rest[0]),
  state: () => state(rest[0]),
};

if (!commands[command]) {
  console.log(`usage (RECORD_REPO=<owner/repo>):
  node harness/record.mjs open "<request>"
  node harness/record.mjs push <run-id>
  node harness/record.mjs pull <run-id>
  node harness/record.mjs list
  node harness/record.mjs drop <run-id>
  node harness/record.mjs state <run-id>`);
  process.exit(1);
}
commands[command]();
