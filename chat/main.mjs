import { resolve } from 'node:path';
import { SessionService } from './sessions.mjs';
import { Repository } from './repository.mjs';
import { GitHubPublisher } from './github.mjs';
import { createAgent } from './agent.mjs';
import { createChatServer } from './http.mjs';

const env = process.env;
for (const key of ['HARNESS_REPO', 'APP_REPO', 'RECORD_REPO', 'HARNESS_GITHUB_TOKEN', 'CHAT_ACCESS_TOKEN']) {
  if (!env[key]) throw new Error(`${key} is required`);
}
if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN');
const dataDir = resolve(env.CHAT_DATA_DIR ?? '.chat-data');
const repository = new Repository(resolve(env.HARNESS_REPO));
const origin = (await repository.git('remote', 'get-url', 'origin')).trim();
const originRepo = origin.replace(/\.git$/, '').match(/github\.com[:/]([^/]+\/[^/]+)$/)?.[1];
if (originRepo !== env.APP_REPO) throw new Error('HARNESS_REPO origin must match APP_REPO on GitHub');
await repository.snapshot();
const publisher = new GitHubPublisher({ repo: env.RECORD_REPO, appRepo: env.APP_REPO,
  token: env.HARNESS_GITHUB_TOKEN, branch: env.RECORD_BRANCH, ref: env.HARNESS_REF });
const service = new SessionService({ dataDir, repository, publisher,
  createAgent: options => createAgent({ ...options, dataDir, repository }) });
const server = createChatServer({ service, token: env.CHAT_ACCESS_TOKEN });
server.listen(Number(env.CHAT_PORT ?? 8787), env.CHAT_HOST ?? '127.0.0.1', () => {
  console.log(`Chat service listening on ${env.CHAT_HOST ?? '127.0.0.1'}:${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  service.close();
  server.closeAllConnections();
  server.close();
});
