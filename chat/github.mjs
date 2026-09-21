import { RequestError } from './contract.mjs';

export class GitHubPublisher {
  constructor({ repo, appRepo, token, branch = 'harness-state', ref = 'main', fetchImpl = fetch }) {
    if (![repo, appRepo].every(value => /^[\w.-]+\/[\w.-]+$/.test(value))) throw new Error('Repository names must be owner/repo');
    if (!token) throw new Error('HARNESS_GITHUB_TOKEN is required');
    Object.assign(this, { repo, appRepo, token, branch, ref, fetchImpl });
  }

  async request(path, method = 'GET', body) {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${path} returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  async getRun(id) {
    if (!/^run-[a-z0-9-]+$/.test(id)) throw new RequestError('Invalid run id');
    const result = await this.request(`contents/runs/${id}.json?ref=${encodeURIComponent(this.branch)}`);
    return JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
  }

  async createRun(run) {
    const target = await this.request('actions/variables/APP_REPO');
    if (target.value !== this.appRepo) throw new RequestError('Workflow APP_REPO does not match the chat repository', 409);
    try {
      await this.request(`contents/runs/${run.id}.json`, 'PUT', {
        message: `${run.id}: approved spec`, branch: this.branch,
        content: Buffer.from(JSON.stringify(run, null, 2)).toString('base64'),
      });
    } catch (error) {
      if (![409, 422].includes(error.status)) throw error;
      const existing = await this.getRun(run.id);
      if (existing.baseCommit !== run.baseCommit || JSON.stringify(existing.spec) !== JSON.stringify(run.spec) || existing.approval?.specHash !== run.approval.specHash) {
        throw new RequestError('Existing run contains a different approved spec or source commit', 409);
      }
      if (existing.state !== undefined && existing.state !== 'clarified') throw new RequestError('The existing run has already started; check Actions', 409);
    }
  }

  async dispatch(runId, fast) {
    await this.request('actions/workflows/execute.yml/dispatches', 'POST', {
      ref: this.ref, inputs: { run_id: runId, mode: 'execute', fast: String(fast) },
    });
  }

  async acceptRun(id) {
    const path = `contents/runs/${id}.json`;
    const file = await this.request(`${path}?ref=${encodeURIComponent(this.branch)}`);
    const run = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (run.state !== 'published') throw new RequestError('Only a published run can be accepted', 409);
    if (run.accepted) return run;
    run.accepted = { at: new Date().toISOString() };
    await this.request(path, 'PUT', { message: `${id}: behavior accepted`, branch: this.branch,
      sha: file.sha, content: Buffer.from(JSON.stringify(run, null, 2)).toString('base64') });
    return run;
  }
}
