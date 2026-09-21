import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../chat/repository.mjs';

test('inspection reads the pinned Git tree, not dirty files or symlink targets', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-repo-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(directory, 'app.js'), 'const fields = ["title", "done"];\n');
  symlinkSync('/etc/passwd', join(directory, 'outside'));
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'test: baseline');
  const repository = new Repository(directory);
  const commit = await repository.snapshot();
  writeFileSync(join(directory, 'app.js'), 'dirty changes');
  assert.deepEqual(await repository.list(commit), ['app.js', 'outside']);
  assert.match(await repository.read(commit, 'app.js'), /title/);
  assert.equal(await repository.read(commit, 'outside'), '/etc/passwd');
  assert.match(JSON.stringify(await repository.search(commit, 'done')), /app.js/);
  await assert.rejects(repository.read(commit, '../outside'), /tracked/i);
  await assert.rejects(repository.read(commit, '.git/config'), /tracked/i);
  await assert.rejects(repository.read('--help', 'app.js'), /commit/i);
});
