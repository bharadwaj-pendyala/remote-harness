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

const runPath = (id) => `${RUNS_DIR}/${id}/run.json`;

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

function clarify(request) {
  const run = saveRun({
    id: `run-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
    request,
    state: 'clarifying',
    baseCommit: sh('git rev-parse HEAD').trim(),
    history: [],
    artifacts: {},
  });

  const { questions } = claude(
    `You are the intake step of an engineering harness for this repository.\n\n` +
      `A non-engineer asked for this change:\n"${request}"\n\n` +
      `Read the repository to understand the current behavior. Ignore the harness/ directory entirely.\n` +
      `Ask ONLY the questions whose answers would change what gets built. Never more than three.\n` +
      `Each must be answerable by someone who does not read code.\n\n` +
      `Reply with JSON only: {"questions":[{"id":"q1","ask":"...","why":"what changes based on the answer"}]}`,
    { json: true },
  );

  transition(run, 'clarifying', { questions });
  console.log(`\nrun: ${run.id}\n`);
  for (const q of questions) console.log(`  ${q.id}. ${q.ask}\n      (${q.why})\n`);
  console.log(`answer with:\n  node harness/run.mjs answer ${run.id} "a1" "a2" ...\n`);
  return run;
}

function answer(id, answers) {
  const run = loadRun(id);
  run.answers = run.questions.map((q, i) => ({ ...q, answer: answers[i] ?? '' }));

  const spec = claude(
    `You are writing the agreed task for an engineering harness.\n\n` +
      `Request: "${run.request}"\n\n` +
      `Clarifying exchange:\n` +
      run.answers.map((a) => `Q: ${a.ask}\nA: ${a.answer}`).join('\n') +
      `\n\nRead the repository, ignoring the harness/ directory. Write the agreed task as JSON only:\n` +
      `{"summary":"one line","acceptance":["observable statements"],"unchanged":["behavior that must not change"],` +
      `"check":"what the automated check must prove","journey":"kebab-case name for the recorded journey"}`,
    { json: true },
  );

  transition(run, 'clarified', { spec });
  console.log(`\n${spec.summary}\n`);
  for (const a of spec.acceptance) console.log(`  + ${a}`);
  for (const u of spec.unchanged) console.log(`  = ${u}`);
  console.log(`\ncheck: ${spec.check}\njourney: ${spec.journey}\n`);
  console.log(`execute with:\n  node harness/run.mjs execute ${run.id}\n`);
  return run;
}

async function execute(id) {
  const run = loadRun(id);
  if (!run.spec) throw new Error(`run ${id} has no agreed spec yet`);

  const branch = `harness/${run.id}`;
  const artifacts = `${RUNS_DIR}/${run.id}/artifacts`;
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
      `Also write two files:\n` +
      `  tests/${run.spec.journey}.spec.ts  a Playwright check proving: ${run.spec.check}\n` +
      `  journeys/${run.spec.journey}.journey.ts  a Playwright journey demonstrating the behavior on screen, ` +
      `with short waits so it is watchable, and no assertions.\n\n` +
      `Existing rows in the tasks table predate this change. Handle that explicitly.\n\n` +
      `Hard limits: do not run the tests. Do not commit. Only edit files in this repository.`,
    { edits: true },
  );

  sh('git add -A');
  const diffstat = sh('git diff --cached --stat').trim();
  if (!diffstat) return stop(run, 'the agent produced no change');
  transition(run, 'implemented', { diffstat });
  console.log(`implemented\n${diffstat}`);

  try {
    writeFileSync(`${artifacts}/checks.log`, stripAnsi(sh('./scripts/check-app 2>&1', { env })));
    transition(run, 'checked');
    console.log('checked    all required checks passed');
  } catch (error) {
    writeFileSync(`${artifacts}/checks.log`, stripAnsi(error.stdout ?? error.message));
    return stop(run, `a required check failed, see ${RUNS_DIR}/${run.id}/artifacts/checks.log`);
  }

  try {
    sh(`./scripts/record-journey ${run.spec.journey}`, { env });
  } catch (error) {
    writeFileSync(`${artifacts}/record.log`, stripAnsi(error.stdout ?? error.message));
    return stop(run, 'the recording failed');
  }
  const video = sh(`find ${artifacts} -name '*.webm' | head -1`).trim();
  if (!video) return stop(run, 'the recording produced no video');
  transition(run, 'recorded', { artifacts: { checks: `${artifacts}/checks.log`, video } });
  console.log(`recorded   ${video}`);

  sh('git add -A');
  sh(
    `git -c user.email=harness@bharad.dev -c user.name="Remote Harness" commit -q -m ` +
      JSON.stringify(run.spec.summary),
  );
  const candidate = sh('git rev-parse HEAD').trim();
  transition(run, 'recorded', { candidate });
  console.log(`candidate  ${candidate.slice(0, 7)}`);

  if (!sh('git remote').trim()) {
    console.log(`\nno git remote configured, so nothing was pushed.`);
    console.log(`publish later with:  node harness/run.mjs publish ${run.id}`);
    return run;
  }
  return publish(run.id);
}

function prBody(run) {
  const checks = stripAnsi(readFileSync(run.artifacts.checks, 'utf8')).trim().split('\n').slice(-40).join('\n');
  const body = [
    `**Change**  ${run.spec.summary}`,
    `**Request**  ${run.request}`,
    `**Candidate**  \`${run.candidate.slice(0, 7)}\` from \`${run.baseCommit.slice(0, 7)}\``,
    `**Run**  \`${run.id}\``,
    ``,
    `### Agreed with the requester`,
    ...run.spec.acceptance.map((a) => `- [x] ${a}`),
    ``,
    `### Review focus`,
    `Existing rows predate this change. Check the stored field, the read path, and reload behavior.`,
    ...run.spec.unchanged.map((u) => `- must still hold: ${u}`),
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
    run.artifacts.videoUrl
      ? run.artifacts.videoUrl
      : `Recorded at \`${run.artifacts.video.replace(`${HARNESS_HOME}/`, '')}\` on the machine that ran this. ` +
        `Not yet hosted: the run was local.`,
    ``,
    `**Acceptance**  pending requester review`,
  ].join('\n');
  return body;
}

function publish(id) {
  const run = loadRun(id);
  if (!run.candidate) throw new Error(`run ${id} has no candidate commit`);

  sh(`git push -q -u origin ${run.branch}`);
  const body = prBody(run);

  const url = sh(
    `gh pr create --draft --title ${JSON.stringify(run.spec.summary)} --body ${JSON.stringify(body)}`,
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
  options: { help: { type: 'boolean', short: 'h' } },
});
const [command, ...rest] = positionals;

const commands = {
  clarify: () => clarify(rest.join(' ')),
  answer: () => answer(rest[0], rest.slice(1)),
  execute: () => execute(rest[0]),
  publish: () => publish(rest[0]),
  accept: () => accept(rest[0]),
  preview: () => console.log(prBody(loadRun(rest[0]))),
  show: () => console.log(JSON.stringify(loadRun(rest[0]), null, 2)),
};

if (values.help || !commands[command]) {
  console.log(`usage (HARNESS_REPO=<path to the application repo>):
  node harness/run.mjs clarify "<request>"
  node harness/run.mjs answer <run-id> "<a1>" "<a2>" ...
  node harness/run.mjs execute <run-id>
  node harness/run.mjs publish <run-id>
  node harness/run.mjs accept <run-id>
  node harness/run.mjs preview <run-id>
  node harness/run.mjs show <run-id>`);
  process.exit(values.help ? 0 : 1);
}
await commands[command]();
