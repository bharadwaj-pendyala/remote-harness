import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { draftSchema, RequestError } from './contract.mjs';

// One service process owns this directory. Never mount it into two replicas.
export class SessionService {
  constructor({ dataDir, repository, createAgent, publisher, idleMs = 15 * 60_000 }) {
    this.directory = join(dataDir, 'sessions');
    this.repository = repository;
    this.createAgent = createAgent;
    this.publisher = publisher;
    this.idleMs = idleMs;
    this.agents = new Map();
    this.timers = new Map();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => name.endsWith('.json'))) {
      const session = this.get(file.slice(0, -5));
      if (session.busy) {
        session.busy = false;
        session.error = 'The service restarted during the last turn. Send a follow-up to resume.';
      }
      if (session.approval?.status === 'dispatching') session.approval.status = 'uncertain';
      if (session.approval?.status === 'preparing') session.approval = null;
      this.save(session);
    }
  }

  get(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new RequestError('Invalid session id', 404);
    try { return JSON.parse(readFileSync(join(this.directory, `${id}.json`), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new RequestError('Session not found', 404);
      throw error;
    }
  }

  save(session) {
    const path = join(this.directory, `${session.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(session, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return structuredClone(session);
  }

  async create() {
    return this.save({
      id: randomUUID(), baseCommit: await this.repository.snapshot(),
      createdAt: new Date().toISOString(), messages: [], sdkSessionId: null,
      revision: 0, spec: null, findings: [], busy: false, error: null, approval: null,
    });
  }

  release(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.agents.get(id)?.close();
    this.agents.delete(id);
  }

  async send(id, content, emit) {
    if (typeof content !== 'string' || !content.trim() || content.length > 20_000) {
      throw new RequestError('A message must contain 1–20000 characters');
    }
    const session = this.get(id);
    if (session.busy) throw new RequestError('A turn is already in progress', 409);
    if (session.approval) throw new RequestError('This conversation has an approved run. Start a new conversation for another change.', 409);
    clearTimeout(this.timers.get(id));
    session.busy = true;
    session.error = null;
    session.spec = null;
    session.messages.push({ role: 'user', content: content.trim() });
    this.save(session);
    try {
      if (!this.agents.has(id)) {
        this.agents.set(id, this.createAgent({
          session,
          onSessionId: sdkSessionId => {
            const current = this.get(id);
            if (current.sdkSessionId !== sdkSessionId) this.save({ ...current, sdkSessionId });
          },
        }));
      }
      const result = await this.agents.get(id).send(content.trim(), emit);
      session.messages.push({ role: 'assistant', content: result.text });
      if (result.draft) {
        const draft = draftSchema.parse(result.draft);
        session.spec = draft.spec;
        session.findings = draft.findings;
        session.revision++;
      }
      const timer = setTimeout(() => this.release(id), this.idleMs);
      timer.unref();
      this.timers.set(id, timer);
    } catch (error) {
      session.error = error.message;
      this.release(id);
      throw error;
    } finally {
      session.busy = false;
      session.sdkSessionId = this.get(id).sdkSessionId;
      this.save(session);
    }
    return this.get(id);
  }

  async approve(id, revision, fast = true) {
    const session = this.get(id);
    if (session.busy) throw new RequestError('A turn is in progress', 409);
    if (!session.spec) throw new RequestError('There is no current draft spec to approve', 409);
    if (revision !== session.revision) throw new RequestError('The spec revision changed; review the current revision', 409);
    if (typeof fast !== 'boolean') throw new RequestError('fast must be a boolean');
    if (session.approval?.status === 'dispatched') return session;
    if (session.approval && session.approval.status !== 'preparing') {
      throw new RequestError('Dispatch is pending or uncertain. Check Actions before any manual retry.', 409);
    }
    const runId = `run-${session.id}`;
    session.busy = true;
    session.error = null;
    session.approval = { runId, revision, status: 'preparing', fast, at: new Date().toISOString() };
    this.save(session);
    const run = {
      id: runId, request: session.messages.find(message => message.role === 'user').content,
      state: 'clarified', baseCommit: session.baseCommit, spec: session.spec, findings: session.findings,
      repairsLeft: 1, history: [{ state: 'clarified', at: session.approval.at }], artifacts: {},
      approval: { sessionId: id, revision, at: session.approval.at,
        specHash: createHash('sha256').update(JSON.stringify(session.spec)).digest('hex') },
    };
    try {
      await this.publisher.createRun(run);
      session.approval.status = 'dispatching';
      this.save(session);
      await this.publisher.dispatch(runId, fast);
      session.approval.status = 'dispatched';
      this.release(id);
    } catch (error) {
      if (session.approval.status === 'dispatching') session.approval.status = 'uncertain';
      else session.approval = null;
      session.error = error.message;
      throw error;
    } finally {
      session.busy = false;
      this.save(session);
    }
    return this.get(id);
  }

  async status(id) {
    const session = this.get(id);
    if (!session.approval || session.busy) return session;
    try { return { ...session, run: await this.publisher.getRun(session.approval.runId) }; }
    catch (error) { return { ...session, statusError: error.message }; }
  }

  async accept(id) {
    const session = this.get(id);
    if (!session.approval || session.busy) throw new RequestError('There is no approved run ready for acceptance', 409);
    return { ...session, run: await this.publisher.acceptRun(session.approval.runId) };
  }

  close() {
    for (const id of this.agents.keys()) this.release(id);
  }
}
