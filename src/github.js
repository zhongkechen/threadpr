import { sign } from 'node:crypto';

const api = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(response) {
    super(`GitHub API returned HTTP ${response.status}`);
    this.status = response.status;
    const rateLimited = response.headers.get('x-ratelimit-remaining') === '0';
    const retryAfter = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    this.retryable = response.status >= 500 || response.status === 429 ||
      (response.status === 403 && (rateLimited || retryAfter > 0));
    this.retryAfterMs = Math.max(
      retryAfter * 1000 || 0,
      rateLimited ? reset - Date.now() : 0,
    );
  }
}

function encode(data) {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'RS256', typ: 'JWT' });
  const payload = encode({ iss: appId, iat: now - 60, exp: now + 540 });
  const data = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
  return `${data}.${signature}`;
}

export function createGitHub({ appId, privateKey, fetchImpl = fetch }) {
  async function request(token, method, path, body) {
    const response = await fetchImpl(api + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'ThreadPR',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new GitHubError(response);
    return response.status === 204 ? null : await response.json();
  }

  return async ({ installationId, repositoryId }) => {
    const credentials = await request(
      appJwt(appId, privateKey),
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      {
        repository_ids: [repositoryId],
        permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' },
      },
    );
    const get = (path) => request(credentials.token, 'GET', path);
    return {
      get,
      post: (path, body) => request(credentials.token, 'POST', path, body),
      async *pages(path, filters = {}) {
        for (let page = 1; ; page += 1) {
          const query = new URLSearchParams({ ...filters, per_page: 100, page });
          const items = await get(`${path}?${query}`);
          yield* items;
          if (items.length < 100) break;
        }
      },
    };
  };
}
