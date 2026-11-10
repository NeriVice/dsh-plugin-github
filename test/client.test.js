import assert from 'node:assert/strict';
import test from 'node:test';

import { GitHubClient, GitHubError } from '../src/client.js';
import { errorResponse, installFetch, respond } from './helpers/fetch.js';

test('builds absolute URLs and forwards the query', () => {
  const client = new GitHubClient({ token: 't', baseUrl: 'https://api.github.com/' });
  assert.equal(client.url('/user/repos', { per_page: 5, page: 1 }), 'https://api.github.com/user/repos?per_page=5&page=1');
  assert.equal(client.url('user'), 'https://api.github.com/user');
  assert.equal(client.url('/x', { skipped: undefined, empty: '' }), 'https://api.github.com/x');
});

test('sends authentication, version, and user agent headers', async () => {
  const stub = installFetch(() => respond({ body: { login: 'octocat' } }));
  try {
    const client = new GitHubClient({ token: 'secret', tokenSource: 'env GITHUB_TOKEN' });
    await client.json('/user');
    const [call] = stub.calls;
    assert.equal(call.headers.authorization, 'Bearer secret');
    assert.equal(call.headers['x-github-api-version'], '2022-11-28');
    assert.equal(call.headers.accept, 'application/vnd.github+json');
    assert.match(call.headers['user-agent'], /dsh-plugin-github/);
  } finally {
    stub.restore();
  }
});

test('omits authorization when no token is configured', async () => {
  const stub = installFetch(() => respond({ body: {} }));
  try {
    const client = new GitHubClient({ token: null, baseUrl: 'https://api.github.com' });
    await client.json('/rate_limit');
    assert.equal(stub.calls[0].headers.authorization, undefined);
  } finally {
    stub.restore();
  }
});

test('maps 401 to a credential message', async () => {
  const stub = installFetch(() => errorResponse('Bad credentials', 401));
  try {
    const client = new GitHubClient({ token: 'bad', tokenSource: 'env GITHUB_TOKEN' });
    await assert.rejects(client.json('/user'), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.match(error.message, /rejected the credentials from env GITHUB_TOKEN/);
      assert.match(error.message, /placeholder text/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('maps a rate-limited 403 to a reset time', async () => {
  const stub = installFetch(() => respond({
    status: 403,
    body: { message: 'API rate limit exceeded' },
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
  }));
  try {
    const client = new GitHubClient({ token: 't' });
    await assert.rejects(client.json('/user'), (error) => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.match(error.message, /2023-11-14T22:13:20/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('maps 404 and 422 to actionable messages', async () => {
  const stub = installFetch((call) => (call.url.includes('/repos/acme/missing')
    ? errorResponse('Not Found', 404)
    : respond({ status: 422, body: { message: 'Validation Failed', errors: [{ field: 'title', message: 'is too long' }] } })));
  try {
    const client = new GitHubClient({ token: 't' });
    await assert.rejects(client.json('/repos/acme/missing'), /404 Not Found/);
    await assert.rejects(client.json('/repos/acme/demo/issues'), (error) => {
      assert.equal(error.code, 'VALIDATION');
      assert.match(error.message, /title: is too long/);
      return true;
    });
  } finally {
    stub.restore();
  }
});

test('list asks only for the requested page size and truncates', async () => {
  const all = Array.from({ length: 40 }, (_, index) => ({ id: index }));
  const stub = installFetch((call) => {
    const perPage = Number(new URL(call.url).searchParams.get('per_page'));
    return respond({ body: all.slice(0, perPage) });
  });
  try {
    const client = new GitHubClient({ token: 't' });
    const items = await client.list('/user/repos', { limit: 12, query: { sort: 'updated' } });
    assert.equal(items.length, 12);
    assert.equal(stub.calls.length, 1);
    const params = new URL(stub.calls[0].url).searchParams;
    assert.equal(params.get('per_page'), '12');
    assert.equal(params.get('sort'), 'updated');
  } finally {
    stub.restore();
  }
});

test('list caps per_page at the GitHub maximum', async () => {
  const stub = installFetch(() => respond({ body: [] }));
  try {
    const client = new GitHubClient({ token: 't' });
    await client.list('/user/repos', { limit: 1000 });
    assert.equal(new URL(stub.calls[0].url).searchParams.get('per_page'), '100');
  } finally {
    stub.restore();
  }
});

test('list refuses a non-list body', async () => {
  const stub = installFetch(() => respond({ body: { message: 'nope' } }));
  try {
    const client = new GitHubClient({ token: 't' });
    await assert.rejects(client.list('/user/repos', { limit: 5 }), /Expected a list/);
  } finally {
    stub.restore();
  }
});

test('download follows the codeload redirect and forwards the token there', async () => {
  const payload = Buffer.from('archive-bytes');
  const stub = installFetch((call) => {
    if (call.url.includes('/tarball')) {
      return respond({
        status: 302,
        body: '',
        headers: { location: 'https://codeload.github.com/acme/demo/legacy.tar.gz/refs/heads/main' },
      });
    }
    return new Response(payload, { status: 200, headers: { 'content-type': 'application/gzip' } });
  });
  try {
    const client = new GitHubClient({ token: 'secret' });
    const body = await client.download('/repos/acme/demo/tarball');
    assert.deepEqual(body, payload);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].headers.authorization, undefined);
    assert.match(stub.calls[1].url, /token=secret/);
  } finally {
    stub.restore();
  }
});

test('download surfaces failures instead of returning an error page', async () => {
  const stub = installFetch((call) => (call.url.includes('codeload')
    ? errorResponse('Not Found', 404)
    : respond({ status: 302, body: '', headers: { location: 'https://codeload.github.com/acme/demo/tar.gz' } })));
  try {
    const client = new GitHubClient({ token: 't' });
    await assert.rejects(client.download('/repos/acme/demo/tarball'), /404 Not Found/);
  } finally {
    stub.restore();
  }
});
