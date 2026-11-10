import assert from 'node:assert/strict';
import test from 'node:test';

import { describeRepo, formatBytes, parseRepo, truncate } from '../src/repo.js';

test('parses owner/name, URLs, and SSH remotes', () => {
  const expected = { owner: 'deepseek-ai', name: 'deepseek-harness', fullName: 'deepseek-ai/deepseek-harness' };
  assert.deepEqual(parseRepo('deepseek-ai/deepseek-harness'), expected);
  assert.deepEqual(parseRepo('  deepseek-ai/deepseek-harness  '), expected);
  assert.deepEqual(parseRepo('https://github.com/deepseek-ai/deepseek-harness'), expected);
  assert.deepEqual(parseRepo('https://github.com/deepseek-ai/deepseek-harness.git'), expected);
  assert.deepEqual(parseRepo('https://github.com/deepseek-ai/deepseek-harness/'), expected);
  assert.deepEqual(parseRepo('git@github.com:deepseek-ai/deepseek-harness.git'), expected);
  assert.deepEqual(parseRepo('ssh://git@github.com/deepseek-ai/deepseek-harness.git'), expected);
});

test('rejects malformed repository references', () => {
  assert.throws(() => parseRepo('deepseek-harness'), /expected "owner\/name"/);
  assert.throws(() => parseRepo('a/b/c'), /expected "owner\/name"/);
  assert.throws(() => parseRepo(''), /must not be empty/);
  assert.throws(() => parseRepo(42), /must be a string/);
});

test('formats byte sizes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('describes a repository in one line', () => {
  const line = describeRepo({
    fullName: 'acme/demo',
    private: true,
    archived: false,
    fork: false,
    description: 'A demo',
    stars: 12,
    language: 'TypeScript',
    updatedAt: '2026-01-02T03:04:05Z',
  });
  assert.equal(line, 'acme/demo [private] (TypeScript, ★ 12, updated 2026-01-02) — A demo');
});

test('describes a repository without optional data', () => {
  assert.equal(describeRepo({ fullName: 'acme/demo' }), 'acme/demo [public]');
});

test('truncates long text with an ellipsis', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('a very long description indeed', 10), 'a very lo…');
  assert.equal(truncate(undefined, 5), '');
});
