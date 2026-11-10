import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply, inject, name } from '../index.js';
import { resetTokenCache } from '../src/token.js';
import { installFetch, respond } from './helpers/fetch.js';
import { validate } from './helpers/schema.js';
import { makeTarGz } from './helpers/tar-builder.js';

// Keep credential discovery and git detection deterministic for every test.
const home = await mkdtemp(path.join(tmpdir(), 'dsh-github-tools-'));
process.env.HOME = home;
process.env.PATH = '/nonexistent-bin';
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

/** Tools with the plain JSON Schema keywords dsh accepts. */
const ALLOWED_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'oneOf', 'description', 'title', 'default', 'examples',
]);

/**
 * @param {string} [cwd]
 * @returns {Map<string, any>}
 */
function harness(cwd) {
  /** @type {Map<string, any>} */
  const tools = new Map();
  apply({
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    workingDirectory: { ensure: async () => cwd ?? process.cwd() },
  }, {});
  return tools;
}

/**
 * Execute a tool and check its value against its own declared output schema.
 * @param {any} tool
 * @param {Record<string, unknown>} args
 * @param {string} [cwd]
 * @returns {Promise<{ value: any, text: string }>}
 */
async function run(tool, args, cwd) {
  const value = await tool.execute(args, { signal: AbortSignal.timeout(10_000), agent: {} });
  assert.deepEqual(validate(tool.output.schema, value), [], `${tool.name} value must satisfy its output schema`);
  const content = tool.output.render(args, value);
  assert.ok(Array.isArray(content) && content.length > 0, `${tool.name} must render content`);
  assert.ok(content.every((block) => block.type === 'text' && typeof block.text === 'string'));
  return { value, text: content.map((block) => block.text).join('\n') };
}

/**
 * @param {string | undefined} token
 */
function authenticate(token) {
  if (token === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = token;
  }
  resetTokenCache();
}

const REPO = {
  full_name: 'acme/demo',
  name: 'demo',
  owner: { login: 'acme' },
  private: false,
  fork: false,
  archived: false,
  description: 'Demo repository',
  default_branch: 'main',
  language: 'TypeScript',
  stargazers_count: 42,
  forks_count: 3,
  open_issues_count: 5,
  watchers_count: 42,
  size: 128,
  topics: ['demo'],
  license: { spdx_id: 'MIT', name: 'MIT License' },
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-01-01T00:00:00Z',
  clone_url: 'https://github.com/acme/demo.git',
  ssh_url: 'git@github.com:acme/demo.git',
  html_url: 'https://github.com/acme/demo',
  homepage: 'https://demo.example',
};

test('registers the GitHub tools with acceptable schemas', () => {
  const tools = harness();
  assert.deepEqual([...tools.keys()].sort(), [
    'github_account',
    'github_clone_repo',
    'github_create_issue',
    'github_get_repo',
    'github_list_issues',
    'github_list_repos',
  ]);
  assert.deepEqual(inject, ['tools', 'workingDirectory']);
  assert.equal(name, 'github-repos');

  for (const tool of tools.values()) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, `${tool.name} needs a useful description`);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(typeof tool.execute, 'function');
    for (const schema of [tool.parameters, tool.output.schema]) {
      walkSchema(schema, tool.name);
    }
  }
});

test('github_account reports anonymous access with the rate limit', async () => {
  authenticate(undefined);
  const stub = installFetch(() => respond({
    body: { resources: { core: { limit: 60, remaining: 59, reset: 1_700_000_000 } } },
    headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
  }));
  try {
    const { value, text } = await run(harness().get('github_account'), {});
    assert.equal(value.authenticated, false);
    assert.equal(value.rateLimit.remaining, 59);
    assert.match(value.note, /no token configured/);
    assert.match(text, /not authenticated/);
    assert.match(text, /Rate limit: 59\/60 remaining/);
  } finally {
    stub.restore();
  }
});

test('github_account reports the authenticated login, scopes, and rate limit', async () => {
  authenticate('test-token');
  const stub = installFetch(() => respond({
    body: { login: 'octocat', name: 'The Octocat', public_repos: 8, total_private_repos: 2 },
    headers: {
      'x-oauth-scopes': 'repo, read:user, workflow',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4998',
      'x-ratelimit-reset': '1700000000',
    },
  }));
  try {
    const { value, text } = await run(harness().get('github_account'), {});
    assert.equal(value.authenticated, true);
    assert.equal(value.login, 'octocat');
    assert.deepEqual(value.scopes, ['repo', 'read:user', 'workflow']);
    assert.equal(value.privateRepos, 2);
    assert.match(text, /authenticated as octocat/);
  } finally {
    stub.restore();
    authenticate(undefined);
  }
});

test('github_list_repos filters by visibility, forks, and query', async () => {
  authenticate('test-token');
  const stub = installFetch(() => respond({
    body: [
      { ...REPO, full_name: 'acme/private-one', name: 'private-one', private: true, description: 'Internal tooling' },
      { ...REPO, full_name: 'acme/forked', name: 'forked', fork: true, description: 'A fork' },
      { ...REPO, full_name: 'acme/archived-one', name: 'archived-one', archived: true, description: 'Old experiments' },
      REPO,
    ],
  }));
  try {
    const tool = harness().get('github_list_repos');

    const all = await run(tool, {});
    assert.equal(all.value.repos.length, 3);
    assert.match(all.text, /acme\/demo/);

    const onlyPrivate = await run(tool, { visibility: 'private' });
    assert.deepEqual(onlyPrivate.value.repos.map((repo) => repo.fullName), ['acme/private-one']);

    const onlyForks = await run(tool, { includeForks: true });
    assert.ok(onlyForks.value.repos.some((repo) => repo.fullName === 'acme/forked'));

    const noArchived = await run(tool, { includeArchived: false });
    assert.equal(noArchived.value.repos.some((repo) => repo.archived), false);

    const searched = await run(tool, { query: 'demo' });
    assert.deepEqual(searched.value.repos.map((repo) => repo.fullName), ['acme/demo']);
  } finally {
    stub.restore();
    authenticate(undefined);
  }
});

test('github_list_repos asks for one owner and falls back to the organizations endpoint', async () => {
  authenticate('test-token');
  const stub = installFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/user') return respond({ body: { login: 'octocat' } });
    if (url.pathname === '/users/acme/repos') return respond({ status: 404, body: { message: 'Not Found' } });
    if (url.pathname === '/orgs/acme/repos') return respond({ body: [REPO] });
    return respond({ status: 500, body: { message: 'unexpected ' + url.pathname } });
  });
  try {
    const { value } = await run(harness().get('github_list_repos'), { owner: 'acme' });
    assert.equal(value.repos.length, 1);
    assert.ok(stub.calls.some((call) => call.url.includes('/orgs/acme/repos')));
  } finally {
    stub.restore();
    authenticate(undefined);
  }
});

test('github_get_repo maps a repository payload', async () => {
  authenticate('test-token');
  const stub = installFetch(() => respond({ body: REPO }));
  try {
    const { value, text } = await run(harness().get('github_get_repo'), { repo: 'https://github.com/acme/demo.git' });
    assert.equal(value.fullName, 'acme/demo');
    assert.equal(value.license, 'MIT');
    assert.deepEqual(value.topics, ['demo']);
    assert.match(text, /Stars 42/);
    assert.equal(stub.calls[0].url, 'https://api.github.com/repos/acme/demo');
  } finally {
    stub.restore();
    authenticate(undefined);
  }
});

test('github_list_issues separates pull requests from issues and honours labels', async () => {
  authenticate('test-token');
  const stub = installFetch(() => respond({
    body: [
      {
        number: 7,
        title: 'Add feature',
        state: 'open',
        user: { login: 'octocat' },
        labels: [{ name: 'enhancement' }, 'good first issue'],
        comments: 2,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        html_url: 'https://github.com/acme/demo/issues/7',
        pull_request: { url: 'https://api.github.com/repos/acme/demo/pulls/7' },
      },
      {
        number: 8,
        title: 'Bug',
        state: 'open',
        user: { login: 'hubot' },
        labels: [],
        comments: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/acme/demo/issues/8',
      },
    ],
  }));
  try {
    const tool = harness().get('github_list_issues');
    const all = await run(tool, { repo: 'acme/demo' });
    assert.equal(all.value.items.length, 2);
    assert.deepEqual(all.value.items.map((item) => item.kind), ['pull', 'issue']);
    assert.match(all.text, /PR #7/);

    const pulls = await run(tool, { repo: 'acme/demo', kind: 'pull' });
    assert.deepEqual(pulls.value.items.map((item) => item.number), [7]);

    const issues = await run(tool, { repo: 'acme/demo', kind: 'issue' });
    assert.deepEqual(issues.value.items.map((item) => item.number), [8]);

    await run(tool, { repo: 'acme/demo', labels: ['bug', 'p1'] });
    const params = new URL(stub.calls.at(-1).url).searchParams;
    assert.equal(params.get('labels'), 'bug,p1');
    assert.equal(params.get('state'), 'open');
  } finally {
    stub.restore();
    authenticate(undefined);
  }
});

test('github_create_issue posts the payload and reports the new issue', async () => {
  authenticate('test-token');
  const stub = installFetch(() => respond({
    status: 201,
    body: {
      number: 12,
      title: 'Crash on start',
      state: 'open',
      html_url: 'https://github.com/acme/demo/issues/12',
      created_at: '2026-02-01T00:00:00Z',
    },
  }));
  try {
    const { value, text } = await run(harness().get('github_create_issue'), {
      repo: 'acme/demo',
      title: 'Crash on start',
      body: 'Steps to reproduce…',
      labels: ['bug'],
    });
    assert.equal(value.number, 12);
    assert.match(text, /Opened issue #12/);
    assert.equal(stub.calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(stub.calls[0].body), { title: 'Crash on start', body: 'Steps to reproduce…', labels: ['bug'] });
  } finally {
    stub.restore();
    authenticate(undefined);
  }
});

test('github_account refreshes the cached credential only when asked', async () => {
  authenticate('token-a');
  const stub = installFetch((call) => respond({
    body: { login: call.headers.authorization === 'Bearer token-b' ? 'second-user' : 'first-user' },
  }));
  try {
    const tool = harness().get('github_account');
    assert.equal((await run(tool, {})).value.login, 'first-user');

    process.env.GITHUB_TOKEN = 'token-b';
    assert.equal((await run(tool, {})).value.login, 'first-user', 'the cached credential is reused');
    assert.equal((await run(tool, { refresh: true })).value.login, 'second-user', 'refresh re-reads the environment');
  } finally {
    stub.restore();
    authenticate(undefined);
  }
});

test('github_clone_repo extracts a snapshot when git is unavailable', async () => {
  authenticate('test-token');
  const archive = makeTarGz([
    { name: 'acme-demo-abc123/', type: '5', mode: 0o755 },
    { name: 'acme-demo-abc123/README.md', content: '# demo\n' },
    { name: 'acme-demo-abc123/src/index.ts', content: 'export const x = 1;\n' },
  ]);
  const stub = installFetch((call) => {
    if (call.url.includes('codeload')) return new Response(archive, { status: 200 });
    return respond({
      status: 302,
      body: '',
      headers: { location: 'https://codeload.github.com/acme/demo/tar.gz/refs/heads/main' },
    });
  });
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-github-clone-'));
  try {
    const { value, text } = await run(harness(cwd).get('github_clone_repo'), { repo: 'acme/demo' });
    assert.equal(value.mode, 'snapshot');
    assert.equal(value.path, 'demo');
    assert.equal(value.files, 2);
    assert.match(value.note, /git is not installed/);
    assert.match(text, /Cloned acme\/demo/);
    assert.equal(await readFile(path.join(cwd, 'demo', 'README.md'), 'utf8'), '# demo\n');
    assert.equal(await readFile(path.join(cwd, 'demo', 'src', 'index.ts'), 'utf8'), 'export const x = 1;\n');
  } finally {
    stub.restore();
    authenticate(undefined);
    await rm(cwd, { recursive: true, force: true });
  }
});

test('github_clone_repo refuses a non-empty destination unless overwrite is set', async () => {
  authenticate('test-token');
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-github-clone-'));
  try {
    await mkdir(path.join(cwd, 'demo'), { recursive: true });
    await writeFile(path.join(cwd, 'demo', 'keep.txt'), 'keep');
    const tool = harness(cwd).get('github_clone_repo');
    await assert.rejects(tool.execute({ repo: 'acme/demo' }, { signal: AbortSignal.timeout(5000), agent: {} }), /already exists and is not empty/);
    await assert.rejects(tool.execute({ repo: 'acme/demo', destination: '/tmp/out' }, { signal: AbortSignal.timeout(5000), agent: {} }), /relative to the Session working directory/);
    await assert.rejects(tool.execute({ repo: 'acme/demo', destination: '../outside' }, { signal: AbortSignal.timeout(5000), agent: {} }), /inside the Session working directory/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    authenticate(undefined);
  }
});

test('github_clone_repo requires a token when git is unavailable', async () => {
  authenticate(undefined);
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-github-clone-'));
  try {
    await assert.rejects(
      harness(cwd).get('github_clone_repo').execute({ repo: 'acme/demo' }, { signal: AbortSignal.timeout(5000), agent: {} }),
      /needs a GitHub token/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('apply rejects invalid configuration', () => {
  const ctx = { tools: { register: () => () => {} }, workingDirectory: { ensure: async () => process.cwd() } };
  assert.throws(() => apply(ctx, { token: '' }), /config\.token must not be empty/);
  assert.throws(() => apply(ctx, { baseUrl: 'not-a-url' }), /config\.baseUrl is not a URL/);
  assert.throws(() => apply(ctx, { timeoutMs: -1 }), /config\.timeoutMs must be a positive number/);
  assert.throws(() => apply(ctx, 'nope'), /config must be a mapping/);
});

/**
 * @param {any} schema
 * @param {string} tool
 */
function walkSchema(schema, tool) {
  if (schema === null || typeof schema !== 'object') return;
  for (const [key, value] of Object.entries(schema)) {
    assert.ok(ALLOWED_KEYWORDS.has(key), `${tool}: unsupported schema keyword "${key}"`);
    if (key === 'required') {
      assert.ok(Array.isArray(value), `${tool}: required must be an array`);
      continue;
    }
    if (key === 'properties') {
      for (const child of Object.values(value)) walkSchema(child, tool);
      continue;
    }
    if (key === 'items' || key === 'oneOf') {
      for (const child of (Array.isArray(value) ? value : [value])) walkSchema(child, tool);
      continue;
    }
    if (key === 'type' || key === 'description' || key === 'title' || key === 'enum' || key === 'const' || key === 'default' || key === 'examples' || key === 'additionalProperties') {
      continue;
    }
    assert.fail(`${tool}: schema keyword "${key}" was not inspected`);
  }
}
