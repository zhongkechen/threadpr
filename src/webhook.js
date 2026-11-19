import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseReviewCommand } from './review.js';

const maxPayloadBytes = 25 * 1024 * 1024;

function authentic(body, signature, secret) {
  if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/u.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const supplied = Buffer.from(signature.slice(7), 'hex');
  return timingSafeEqual(supplied, expected);
}

export function createWebhook({ secret, enqueue, notify = () => {}, logger = console }) {
  return async (request, response) => {
    const path = request.url.split('?', 1)[0];
    if (request.method === 'GET' && (path === '/healthz' || path === '/')) {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(path === '/healthz' ? 'ok\n' : 'ThreadPR\nPost mini PRs in code review threads.\n');
      return;
    }
    if (request.method !== 'POST' || path !== '/webhooks/github') {
      response.writeHead(404).end();
      return;
    }

    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > maxPayloadBytes) {
          response.writeHead(413, { Connection: 'close' }).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!authentic(body, request.headers['x-hub-signature-256'], secret)) {
        response.writeHead(401).end();
        return;
      }
      if (request.headers['x-github-event'] !== 'pull_request_review_comment') {
        response.writeHead(204).end();
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      const command = parseReviewCommand(payload);
      if (!command) {
        response.writeHead(204).end();
        return;
      }
      enqueue(command);
      response.writeHead(202).end();
      notify();
    } catch (error) {
      logger.error('ThreadPR could not accept a webhook', error.name);
      if (!response.headersSent) response.writeHead(503).end();
    }
  };
}
