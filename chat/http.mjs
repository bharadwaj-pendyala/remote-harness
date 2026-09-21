import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { RequestError } from './contract.mjs';

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64_000) throw new RequestError('Request body is too large', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected an object');
    return value;
  } catch { throw new RequestError('Expected a JSON object'); }
}

export function createChatServer({ service, token }) {
  if (!token) throw new Error('CHAT_ACCESS_TOKEN is required');
  const expected = Buffer.from(`Bearer ${token}`);
  return createServer(async (request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/health' && request.method === 'GET') return json(200, { status: 'ok' });
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(401, { error: 'Unauthorized' });
      if (path === '/sessions' && request.method === 'POST') {
        await readBody(request);
        return json(201, await service.create());
      }
      const match = path.match(/^\/sessions\/([^/]+)(?:\/(messages|approve|accept))?$/);
      if (!match) return json(404, { error: 'Route not found' });
      const [, id, action] = match;
      if (!action && request.method === 'GET') return json(200, await service.status(id));
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
      const body = await readBody(request);
      if (action === 'approve') return json(200, await service.approve(id, body.revision, body.fast));
      if (action === 'accept') return json(200, await service.accept(id));
      if (action !== 'messages') return json(404, { error: 'Route not found' });
      const emit = event => {
        if (response.destroyed) return;
        if (!response.headersSent) response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        response.write(`${JSON.stringify(event)}\n`);
      };
      const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 10_000);
      try {
        const session = await service.send(id, body.message, emit);
        emit({ type: 'done', session });
        response.end();
      } finally { clearInterval(heartbeat); }
    } catch (error) {
      console.error('Chat request failed:', error.message);
      if (response.destroyed) return;
      if (response.headersSent) response.end(`${JSON.stringify({ type: 'error', error: error.message })}\n`);
      else json(error instanceof RequestError ? error.status : 502, { error: error.message });
    }
  });
}
