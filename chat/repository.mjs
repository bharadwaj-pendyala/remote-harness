import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class Repository {
  constructor(directory) { this.directory = directory; }

  async git(...args) {
    const { stdout } = await exec('git', ['-C', this.directory, ...args], {
      encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  }

  async snapshot() { return (await this.git('rev-parse', 'HEAD')).trim(); }

  async list(commit) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid source commit');
    return (await this.git('ls-tree', '-rz', '--name-only', commit)).split('\0').filter(Boolean);
  }

  async read(commit, path) {
    if (!(await this.list(commit)).includes(path)) throw new Error('Read requires a tracked file in this source commit');
    return (await this.git('show', `${commit}:${path}`)).slice(0, 60_000);
  }

  async search(commit, text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Search text cannot be empty');
    await this.list(commit);
    try {
      return (await this.git('grep', '-n', '-I', '-F', '-e', text, commit, '--')).slice(0, 30_000);
    } catch (error) {
      if (error.code === 1) return 'No matching source lines.';
      throw error;
    }
  }
}
