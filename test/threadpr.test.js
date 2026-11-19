import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createGitHub } from '../src/github.js';
import { parseReviewCommand, propose } from '../src/review.js';
import { openStore } from '../src/store.js';
import { createWebhook } from '../src/webhook.js';
import { drainJobs } from '../src/worker.js';

const secret = 'test-fixture-secret';
const repository = { id: 1, full_name: 'example/demo', owner: { login: 'example' } };
const botLogin = 'threadpr[bot]';
const user = { id: 2, login: 'alice', type: 'User' };
const parentSha = 'a'.repeat(40);
const reviewSha = 'b'.repeat(40);

function reviewEvent({
  prNumber = 42,
  commentId = 11,
  branch = 'review/alice-fix',
  repositoryInfo = repository,
  installation = 3,
} = {}) {
  return {
    action: 'created',
    repository: repositoryInfo,
    installation: { id: installation },
    sender: user,
    pull_request: { number: prNumber },
    comment: {
      id: commentId,
      user,
      body: `/mini-pr ${branch}\n\nCover a write failure.`,
    },
  };
}

function fixture({ parentRef = 'feature/export', parentRepo = repository, status = 'ahead',
  permission = 'write' } = {}) {
  const pulls = [];
  const replies = [];
  return {
    pulls,
    replies,
    async get(path) {
      if (/\/collaborators\/alice\/permission$/.test(path)) return { permission };
      if (/\/pulls\/\d+$/.test(path)) {
        return { state: 'open', head: { ref: parentRef, sha: parentSha, repo: parentRepo } };
      }
      if (path.includes('/branches/')) {
        return { name: decodeURIComponent(path.split('/').at(-1)), commit: { sha: reviewSha } };
      }
      if (path.endsWith(`/compare/${parentSha}...${reviewSha}`)) return { status };
      assert.fail(`Unexpected GET ${path}`);
    },
    async post(path, body) {
      if (path.endsWith('/pulls')) {
        const number = 100 + pulls.length;
        const pull = {
          ...body,
          number,
          state: 'open',
          user: { login: botLogin },
          html_url: `https://github.com/example/demo/pull/${number}`,
        };
        pulls.push(pull);
        return pull;
      }
      const match = path.match(/\/comments\/(\d+)\/replies$/);
      assert.ok(match, `Unexpected POST ${path}`);
      const comment = { ...body, user: { login: botLogin }, in_reply_to_id: Number(match[1]) };
      replies.push(comment);
      return comment;
    },
    async *pages(path, filters) {
      if (path.endsWith('/pulls')) {
        for (const pull of pulls) {
          if (pull.base === filters.base && filters.head.endsWith(`:${pull.head}`)) {
            yield {
              ...pull,
              head: { ref: pull.head, repo: parentRepo },
              base: { ref: pull.base, repo: parentRepo },
            };
          }
        }
      } else if (path.endsWith('/comments')) {
        yield* replies;
      } else {
        assert.fail(`Unexpected paginated path ${path}`);
      }
    },
  };
}

test('a signed comment creates a mini PR and a duplicate delivery creates no additional resources', async (t) => {
  const store = openStore(':memory:');
  const client = fixture();
  const server = createServer(createWebhook({ secret, enqueue: store.enqueue }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/webhooks/github`;
  const body = JSON.stringify(reviewEvent());
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const deliver = (value) => fetch(url, {
    method: 'POST',
    body,
    headers: { 'x-hub-signature-256': value, 'x-github-event': 'pull_request_review_comment' },
  });
  let response = await deliver('sha256=' + '0'.repeat(64));
  assert.equal(response.status, 401);
  assert.equal(store.next(Date.now()), null);
  for (let i = 0; i < 2; i += 1) {
    response = await deliver(signature);
    assert.equal(response.status, 202);
    await drainJobs({
      store,
      botLogin,
      async github(job) {
        assert.equal(job.installationId, 3);
        assert.equal(job.repositoryId, 1);
        return client;
      },
    });
  }
  assert.equal(client.pulls.length, 1);
  assert.equal(client.pulls[0].head, 'review/alice-fix');
  assert.equal(client.pulls[0].base, 'feature/export');
  assert.match(client.pulls[0].body, /pull\/42#discussion_r11/);
  assert.equal(client.replies.length, 1);
  assert.equal(client.replies[0].in_reply_to_id, 11);
  assert.match(client.replies[0].body, /pull\/100/);
});

test('a reviewer can create another layer in a different repository installation', async () => {
  const other = { id: 99, full_name: 'second/project', owner: { login: 'second' } };
  const event = reviewEvent({
    prNumber: 100, commentId: 12, branch: 'review/bob-test', repositoryInfo: other, installation: 13,
  });
  event.comment.in_reply_to_id = 10;
  const job = parseReviewCommand(event);
  assert.equal(job.threadId, 10);
  assert.equal(job.installationId, 13);
  assert.equal(job.repositoryId, 99);
  const client = fixture({ parentRef: 'review/alice-fix', parentRepo: other });
  await propose(client, job, botLogin);
  assert.equal(client.pulls[0].head, 'review/bob-test');
  assert.equal(client.pulls[0].base, 'review/alice-fix');
});

test('forked and out-of-date branches receive a useful response, and read-only actors create no PR', async () => {
  const job = parseReviewCommand(reviewEvent());
  const forked = fixture({ parentRepo: { id: 10 } });
  assert.match(await propose(forked, job, botLogin), /same repository/);
  const stale = fixture({ status: 'diverged' });
  assert.match(await propose(stale, job, botLogin), /latest commit/);
  const reader = fixture({ permission: 'read' });
  assert.equal(await propose(reader, job, botLogin), null);
  for (const client of [forked, stale, reader]) assert.equal(client.pulls.length, 0);
});

test('uncertain GitHub responses resume without creating a second PR or a second reply', async () => {
  const store = openStore(':memory:');
  try {
    const client = fixture();
    const post = client.post;
    client.post = async (path, body) => {
      const result = await post(path, body);
      throw new TypeError(`Response lost for ${result.number ? 'PR' : 'reply'}`);
    };
    store.enqueue(parseReviewCommand(reviewEvent()));
    for (const now of [0, 3000, 8000]) {
      await drainJobs({
        store,
        botLogin,
        github: async () => client,
        now: () => now,
        logger: { warn() {}, error() { assert.fail('Unexpected terminal error'); } },
      });
    }
    assert.equal(client.pulls.length, 1);
    assert.equal(client.replies.length, 1);
    assert.equal(store.next(Infinity), null);
  } finally {
    store.close();
  }
});

test('GitHub authentication signs an App JWT and scopes the installation token to the event repository', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const github = createGitHub({
    appId: '123',
    privateKey,
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return Response.json(calls.length === 1 ? { token: 'installation-fixture' } : { ok: true });
    },
  });
  const client = await github({ installationId: 77, repositoryId: 55 });
  await client.get('/repos/example/demo/pulls/42');
  assert.match(calls[0].url, /\/installations\/77\/access_tokens$/);
  assert.deepEqual(JSON.parse(calls[0].options.body).repository_ids, [55]);
  const token = calls[0].options.headers.Authorization.slice(7);
  const [header, payload, signature] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, '123');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(calls[1].options.headers.Authorization, 'Bearer installation-fixture');
});

test('the registration URL prefills the private App name, webhook and permissions', () => {
  const result = spawnSync(process.execPath, ['scripts/registration.js', 'https://threadpr.example.com'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const url = new URL(result.stdout.trim());
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.searchParams.get('name'), 'ThreadPR');
  assert.equal(url.searchParams.get('public'), 'false');
  assert.equal(url.searchParams.get('webhook_url'), 'https://threadpr.example.com/webhooks/github');
  assert.equal(url.searchParams.get('pull_requests'), 'write');
  assert.equal(url.searchParams.get('contents'), 'read');
  assert.equal(url.searchParams.get('events[]'), 'pull_request_review_comment');
});
