#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';

import { resolve } from 'node:path';

const HARNESS_HOME = resolve(import.meta.dirname, '..');
const RUNS_DIR = process.env.RUNS_DIR ?? `${HARNESS_HOME}/runs`;
const REPO = resolve(process.env.HARNESS_REPO ?? process.cwd());
const REPAIR_BUDGET = Number(process.env.REPAIR_BUDGET ?? 1);

const runPath = (id) => `${RUNS_DIR}/${id}/run.json`;
const artifactsDir = (id) => `${RUNS_DIR}/${id}/artifacts`;

function loadRun(id) {
  if (!existsSync(runPath(id))) throw new Error(`no run record for ${id}`);
  return JSON.parse(readFileSync(runPath(id), 'utf8'));
}

function saveRun(run) {
  mkdirSync(`${RUNS_DIR}/${run.id}`, { recursive: true });
  writeFileSync(runPath(run.id), JSON.stringify(run, null, 2));
  return run;
}

function transition(run, state, extra = {}) {
  run.state = state;
  run.history.push({ state, at: new Date().toISOString() });
  Object.assign(run, extra);
  return saveRun(run);
}

function stop(run, reason) {
  transition(run, 'stopped', { reason });
  console.error(`\nstopped    ${reason}`);
  console.error(`evidence   ${RUNS_DIR}/${run.id}/`);
  process.exitCode = 1;
  return run;
}

const stripAnsi = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '');

const sh = (cmd, opts = {}) =>
  execSync(cmd, { encoding: 'utf8', cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function claude(prompt, { json = false, edits = false } = {}) {
  const args = edits ? ['--permission-mode', 'acceptEdits', '-p', prompt] : ['-p', prompt];
  const out = execFileSync('claude', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (!json) return out.trim();

  const match = out.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`expected JSON, got:\n${out.slice(0, 400)}`);
  return JSON.parse(match[0]);
}

function clarify(request, id) {
  const run = saveRun({
    id: id ?? `run-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
    request,
    state: 'clarifying',
    baseCommit: sh('git rev-parse HEAD').trim(),
    repairsLeft: REPAIR_BUDGET,
    history: [],
    artifacts: {},
  });

  const { questions, findings } = claude(
    `You are the intake step of an engineering harness for this repository.\n\n` +
      `A non-engineer asked for this change:\n"${request}"\n\n` +
      `Read the repository to understand the current behavior.\n` +
      `Ask ONLY the questions whose answers would change what gets built. Never more than three.\n` +
      `Each must be answerable by someone who does not read code.\n\n` +
      `Also record what you learned, so a later step does not have to rediscover it.\n\n` +
      `Reply with JSON only:\n` +
      `{"questions":[{"id":"q1","ask":"...","why":"what changes based on the answer"}],` +
      `"findings":[{"path":"file you read","note":"what it means for this change"}]}`,
    { json: true },
  );

  transition(run, 'clarifying', { questions, findings });
  console.log(`\nrun: ${run.id}\n`);
  for (const q of questions) console.log(`  ${q.id}. ${q.ask}\n      (${q.why})\n`);
  for (const f of findings ?? []) console.log(`  found  ${f.path}  ${f.note}`);
  return run;
}

function answer(id, reply) {
  const run = loadRun(id);

  const spec = claude(
    `You are writing the agreed task for an engineering harness.\n\n` +
      `Request: "${run.request}"\n\n` +
      `You asked:\n` +
      run.questions.map((q) => `${q.id}. ${q.ask}`).join('\n') +
      `\n\nThey replied, in their own words:\n"${reply}"\n\n` +
      `What intake already found in the repository:\n` +
      (run.findings ?? []).map((f) => `  ${f.path}: ${f.note}`).join('\n') +
      `\n\nMatch their reply to the questions. Where they did not answer one, choose the smaller change ` +
      `and say so in the summary.\n\n` +
      `Write the agreed task as JSON only:\n` +
      `{"summary":"one line","acceptance":["observable statements"],"unchanged":["behavior that must not change"],` +
      `"check":"what the automated check must prove","journey":"kebab-case name for the recorded journey",` +
      `"reviewFocus":"the one decision in this diff a reviewer must check, in a sentence"}`,
    { json: true },
  );

  transition(run, 'clarified', { reply, spec });
  console.log(`\n${spec.summary}\n`);
  for (const a of spec.acceptance) console.log(`  + ${a}`);
  for (const u of spec.unchanged) console.log(`  = ${u}`);
  console.log(`\ncheck: ${spec.check}\njourney: ${spec.journey}\n`);
  return run;
}

function runChecks(run, env) {
  const log = `${artifactsDir(run.id)}/checks.log`;
  try {
    writeFileSync(log, stripAnsi(sh('./scripts/check-app 2>&1', { env })));
    return { passed: true, log };
  } catch (error) {
    writeFileSync(log, stripAnsi(error.stdout ?? error.message));
    return { passed: false, log };
  }
}

function recordJourney(run, env) {
  const artifacts = artifactsDir(run.id);
  const log = `${artifacts}/record.log`;
  try {
    sh(`./scripts/record-journey ${run.spec.journey}`, { env });
  } catch (error) {
    writeFileSync(log, stripAnsi(error.stdout ?? error.message));
    run.artifacts = { ...run.artifacts, record: log };
    return null;
  }
  const webm = sh(`find ${artifacts} -name '*.webm' | head -1`).trim();
  if (!webm) return null;

  const mp4 = `${artifacts}/demo.mp4`;
  sh(`ffmpeg -y -loglevel error -i ${JSON.stringify(webm)} -c:v libx264 -pix_fmt yuv420p ${mp4}`);
  return { webm, mp4 };
}

function commitCandidate(run) {
  sh('git add -A');
  sh(
    `git -c user.email=harness@bharad.dev -c user.name="Remote Harness" commit -q -m ` +
      JSON.stringify(run.spec.summary),
  );
  return sh('git rev-parse HEAD').trim();
}

async function execute(id) {
  const run = loadRun(id);
  if (!run.spec) throw new Error(`run ${id} has no agreed spec yet`);

  const branch = `harness/${run.id}`;
  const artifacts = artifactsDir(run.id);
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ARTIFACTS_DIR: artifacts };

  mkdirSync(artifacts, { recursive: true });
  sh(`git checkout -q -B ${branch} ${run.baseCommit}`);
  transition(run, 'prepared', { branch, port });
  console.log(`prepared   ${branch} from ${run.baseCommit.slice(0, 7)} on port ${port}`);

  claude(
    `Implement this agreed task in the repository.\n\n` +
      `Summary: ${run.spec.summary}\n` +
      `Acceptance:\n${run.spec.acceptance.map((a) => `  - ${a}`).join('\n')}\n` +
      `Must not change:\n${run.spec.unchanged.map((u) => `  - ${u}`).join('\n')}\n\n` +
      `What intake already found:\n` +
      (run.findings ?? []).map((f) => `  ${f.path}: ${f.note}`).join('\n') +
      `\n\nAlso write two files:\n` +
      `  tests/${run.spec.journey}.spec.ts  a Playwright check proving: ${run.spec.check}\n` +
      `  journeys/${run.spec.journey}.journey.ts  a Playwright journey demonstrating the behavior on screen, ` +
      `with short waits so it is watchable, and no assertions.\n` +
      `Playwright runs in strict mode. Every locator in both files must resolve to exactly one element, ` +
      `so prefer an exact name, a test id, or a scoped parent over a bare role and label.\n\n` +
      `Existing rows in the tasks table predate this change. Handle that explicitly.\n\n` +
      `Hard limits: do not run the tests. Do not commit. Do not touch .github/. ` +
      `Only edit files in this repository.`,
    { edits: true },
  );

  sh('git add -A');
  const diffstat = sh('git diff --cached --stat').trim();
  if (!diffstat) return stop(run, 'the agent produced no change');
  transition(run, 'implemented', { diffstat });
  console.log(`implemented\n${diffstat}`);

  return finish(run, env);
}

function finish(run, env) {
  const checks = runChecks(run, env);
  run.artifacts = { ...run.artifacts, checks: checks.log };
  if (!checks.passed) {
    transition(run, 'check-failed');
    console.log(`check-failed  see ${checks.log}`);
    console.log(`repairs left  ${run.repairsLeft}`);
    return run;
  }
  transition(run, 'checked');
  console.log('checked    all required checks passed');

  const video = recordJourney(run, env);
  if (!video) {
    transition(run, 'record-failed');
    console.log(`record-failed  see ${artifactsDir(run.id)}/record.log`);
    console.log(`repairs left   ${run.repairsLeft}`);
    return run;
  }

  const candidate = commitCandidate(run);
  transition(run, 'recorded', {
    candidate,
    artifacts: { ...run.artifacts, video: video.webm, mp4: video.mp4 },
  });
  console.log(`recorded   ${video.mp4}`);
  console.log(`candidate  ${candidate.slice(0, 7)}`);

  return review(run);
}

async function repair(id) {
  const run = loadRun(id);
  if (!['check-failed', 'record-failed', 'review-failed'].includes(run.state)) {
    throw new Error(`run ${id} is not waiting on a repair`);
  }
  if (run.repairsLeft <= 0) return stop(run, 'the repair budget is spent');

  const artifacts = artifactsDir(run.id);
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ARTIFACTS_DIR: artifacts };

  const tail = (path) => readFileSync(path, 'utf8').trim().split('\n').slice(-60).join('\n');

  const complaint = {
    'check-failed': () => `A required check failed.\n\nCheck output:\n${tail(run.artifacts.checks)}`,
    'record-failed': () =>
      `The checks passed, but recording the journey failed, so there is no video.\n\n` +
      `Fix journeys/${run.spec.journey}.journey.ts only. Do not change the implementation.\n` +
      `Playwright runs in strict mode, so every locator must resolve to exactly one element.\n\n` +
      `Recording output:\n${tail(run.artifacts.record)}`,
    'review-failed': () =>
      `A reviewer refused to merge this.\n\n` +
      run.review
        .filter((f) => f.severity === 'blocking')
        .map((f) => `  ${f.path}: ${f.claim}\n    ${f.why}`)
        .join('\n'),
  }[run.state]();

  transition(run, 'repairing', { repairsLeft: run.repairsLeft - 1 });
  console.log(`repairing  ${run.repairsLeft} left after this attempt`);

  claude(
    `Repair your implementation.\n\n` +
      `Summary: ${run.spec.summary}\n` +
      `The check must prove: ${run.spec.check}\n\n` +
      `${complaint}\n\n` +
      `Fix the implementation, not the check, unless the check itself is wrong.\n` +
      `Hard limits: do not run the tests. Do not commit. Do not touch .github/.`,
    { edits: true },
  );

  return finish(run, env);
}

function review(run) {
  const diff = sh(`git diff ${run.baseCommit}..HEAD`).slice(0, 60000);

  const { findings } = claude(
    `You are reviewing a diff an agent wrote. Argue against it.\n\n` +
      `The agreed task:\n${run.spec.summary}\n` +
      `Acceptance:\n${run.spec.acceptance.map((a) => `  - ${a}`).join('\n')}\n` +
      `Must not change:\n${run.spec.unchanged.map((u) => `  - ${u}`).join('\n')}\n\n` +
      `What intake found before any of this was written:\n` +
      (run.findings ?? []).map((f) => `  ${f.path}: ${f.note}`).join('\n') +
      `\n\nThe diff:\n${diff}\n\n` +
      `Look for behavior the diff breaks, data that predates it, and acceptance lines it only ` +
      `appears to satisfy. Do not restate what the diff does. Do not praise it.\n` +
      `Call a finding blocking only when a reviewer would refuse to merge.\n\n` +
      `Reply with JSON only:\n` +
      `{"findings":[{"severity":"blocking|note","path":"file","claim":"what is wrong",` +
      `"why":"the case against it in one sentence"}]}`,
    { json: true },
  );

  const blocking = findings.filter((f) => f.severity === 'blocking');
  transition(run, blocking.length ? 'review-failed' : 'reviewed', { review: findings });

  for (const f of findings) console.log(`  ${f.severity.padEnd(8)} ${f.path}  ${f.claim}`);
  console.log(blocking.length ? `review-failed  ${blocking.length} blocking` : 'reviewed   nothing blocking');
  return run;
}

function prBody(run) {
  const checks = stripAnsi(readFileSync(run.artifacts.checks, 'utf8')).trim().split('\n').slice(-40).join('\n');
  return [
    `**Change**  ${run.spec.summary}`,
    `**Request**  ${run.request}`,
    `**Candidate**  \`${run.candidate.slice(0, 7)}\` from \`${run.baseCommit.slice(0, 7)}\``,
    `**Run**  \`${run.id}\``,
    ``,
    `### Agreed with the requester`,
    ...run.spec.acceptance.map((a) => `- [x] ${a}`),
    ``,
    `### Review focus`,
    run.spec.reviewFocus ?? 'Check the stored field, the read path, and reload behavior.',
    ...run.spec.unchanged.map((u) => `- must still hold: ${u}`),
    ``,
    `### What the reviewer argued`,
    ...(run.review ?? []).map((f) => `- **${f.path}** ${f.claim}. ${f.why}`),
    (run.review ?? []).length ? `` : `Nothing. The reviewer found no case against this diff.`,
    ``,
    `### Checks`,
    `All required checks passed. Command: \`./scripts/check-app\``,
    `<details><summary>Full output</summary>`,
    ``,
    '```',
    checks,
    '```',
    ``,
    `</details>`,
    ``,
    `### Demo video`,
    run.artifacts.mp4,
    ``,
    `**Acceptance**  pending requester review`,
  ].join('\n');
}

function publish(id) {
  const run = loadRun(id);
  if (!run.candidate) throw new Error(`run ${id} has no candidate commit`);

  const bodyFile = `${RUNS_DIR}/${run.id}/pr-body.md`;
  writeFileSync(bodyFile, prBody(run));
  sh(`git push -q -u origin ${run.branch}`);

  const url = sh(
    `gh pr create --draft --title ${JSON.stringify(run.spec.summary)} ` +
      `--body-file ${JSON.stringify(bodyFile)} --attach ${JSON.stringify(run.artifacts.mp4)}`,
  ).trim();
  transition(run, 'published', { pr: url });
  console.log(`published  ${url}`);
  return run;
}

function accept(id) {
  const run = loadRun(id);
  transition(run, run.state, { accepted: { at: new Date().toISOString() } });
  console.log(`accepted   ${run.id}`);
  if (run.pr) console.log(`review     ${run.pr}`);
  return run;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { help: { type: 'boolean', short: 'h' }, id: { type: 'string' } },
});
const [command, ...rest] = positionals;

const commands = {
  clarify: () => clarify(rest.join(' '), values.id),
  answer: () => answer(rest[0], rest.slice(1).join(' ')),
  execute: () => execute(rest[0]),
  repair: () => repair(rest[0]),
  review: () => review(loadRun(rest[0])),
  publish: () => publish(rest[0]),
  accept: () => accept(rest[0]),
  preview: () => console.log(prBody(loadRun(rest[0]))),
  show: () => console.log(JSON.stringify(loadRun(rest[0]), null, 2)),
};

if (values.help || !commands[command]) {
  console.log(`usage (HARNESS_REPO=<path to the application repo>):
  node harness/run.mjs clarify [--id <run-id>] "<request>"
  node harness/run.mjs answer <run-id> "<their reply>"
  node harness/run.mjs execute <run-id>
  node harness/run.mjs repair <run-id>
  node harness/run.mjs review <run-id>
  node harness/run.mjs publish <run-id>
  node harness/run.mjs accept <run-id>
  node harness/run.mjs preview <run-id>
  node harness/run.mjs show <run-id>`);
  process.exit(values.help ? 0 : 1);
}
await commands[command]();
