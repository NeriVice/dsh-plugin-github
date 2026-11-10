import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveToken, resetTokenCache } from '../src/token.js';

/**
 * Run one assertion with a controlled home directory and environment.
 * @param {{ home: string, env?: Record<string, string | undefined> } } options
 * @param {() => void | Promise<void>} body
 */
async function withEnvironment({ home, env = {} }, body) {
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  const saved = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
  };
  process.env.HOME = home;
  process.env.PATH = '/nonexistent-bin';
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetTokenCache();
  try {
    await body();
  } finally {
    resetTokenCache();
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the plugin config wins over every other source', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-github-home-'));
  try {
    await mkdir(path.join(home, '.dsh'), { recursive: true });
    await writeFile(path.join(home, '.dsh', 'github-token'), 'file-token\n');
    await withEnvironment({ home, env: { GITHUB_TOKEN: 'env-token' } }, () => {
      const resolved = resolveToken({ token: 'config-token' });
      assert.deepEqual(resolved, { token: 'config-token', source: 'plugin config' });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('environment variables are used before token files', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-github-home-'));
  try {
    await mkdir(path.join(home, '.dsh'), { recursive: true });
    await writeFile(path.join(home, '.dsh', 'github-token'), 'file-token\n');
    await withEnvironment({ home, env: { GITHUB_TOKEN: 'env-token' } }, () => {
      assert.deepEqual(resolveToken(), { token: 'env-token', source: 'environment GITHUB_TOKEN' });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('GH_TOKEN is the second environment fallback', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-github-home-'));
  try {
    await withEnvironment({ home, env: { GH_TOKEN: 'gh-token' } }, () => {
      assert.deepEqual(resolveToken(), { token: 'gh-token', source: 'environment GH_TOKEN' });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('reads the token file and trims whitespace', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-github-home-'));
  try {
    await mkdir(path.join(home, '.dsh'), { recursive: true });
    await writeFile(path.join(home, '.dsh', 'github-token'), '  file-token \n');
    await withEnvironment({ home }, () => {
      const resolved = resolveToken();
      assert.equal(resolved.token, 'file-token');
      assert.match(resolved.source, /github-token$/);
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('reports no credential when nothing is configured', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-github-home-'));
  try {
    await withEnvironment({ home }, () => {
      assert.deepEqual(resolveToken(), { token: null, source: 'none' });
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('caches the resolution and refreshes on demand', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-github-home-'));
  try {
    await withEnvironment({ home, env: { GITHUB_TOKEN: 'first' } }, () => {
      assert.equal(resolveToken().token, 'first');
      process.env.GITHUB_TOKEN = 'second';
      assert.equal(resolveToken().token, 'first', 'cached for the cache window');
      assert.equal(resolveToken({}, { force: true }).token, 'second');
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
