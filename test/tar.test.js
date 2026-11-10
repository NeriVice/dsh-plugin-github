import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractTarball } from '../src/tar.js';
import { makeTarGz } from './helpers/tar-builder.js';

/**
 * @returns {Promise<string>}
 */
async function temporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), 'dsh-github-tar-'));
}

test('extracts files, strips the top-level archive directory, and preserves the executable bit', async () => {
  const root = await temporaryDirectory();
  try {
    const archive = makeTarGz([
      { name: 'acme-demo-abc123/', type: '5', mode: 0o755 },
      { name: 'acme-demo-abc123/README.md', content: '# demo\n' },
      { name: 'acme-demo-abc123/src/run.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      { name: 'acme-demo-abc123/src/nested/deep.txt', content: 'deep' },
    ]);

    const stats = await extractTarball(archive, root);

    assert.equal(stats.files, 3);
    assert.equal(stats.directories, 1);
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), '# demo\n');
    assert.equal(await readFile(path.join(root, 'src', 'nested', 'deep.txt'), 'utf8'), 'deep');
    assert.equal((await stat(path.join(root, 'src', 'run.sh'))).mode & 0o111, 0o111);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps the top-level directory when stripping is disabled', async () => {
  const root = await temporaryDirectory();
  try {
    const archive = makeTarGz([{ name: 'acme-demo-abc123/file.txt', content: 'x' }]);
    await extractTarball(archive, root, { stripTopLevel: false });
    assert.equal(await readFile(path.join(root, 'acme-demo-abc123', 'file.txt'), 'utf8'), 'x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses path traversal entries instead of writing outside the destination', async () => {
  const root = await temporaryDirectory();
  const outside = path.join(root, '..', 'escaped.txt');
  try {
    const archive = makeTarGz([
      { name: 'acme-demo-abc123/../../escaped.txt', content: 'nope' },
      { name: 'acme-demo-abc123/safe.txt', content: 'ok' },
    ]);
    const stats = await extractTarball(archive, path.join(root, 'repo'));
    assert.equal(await readFile(path.join(root, 'repo', 'safe.txt'), 'utf8'), 'ok');
    await assert.rejects(stat(outside));
    assert.ok(stats.skipped.length >= 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips symlinks and reports them', async () => {
  const root = await temporaryDirectory();
  try {
    const archive = makeTarGz([
      { name: 'acme-demo-abc123/link', type: '2', content: '', linkname: 'README.md' },
      { name: 'acme-demo-abc123/file.txt', content: 'x' },
    ]);
    const stats = await extractTarball(archive, root);
    assert.deepEqual(stats.skipped, ['acme-demo-abc123/link']);
    assert.equal(stats.files, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a body that is not gzip', async () => {
  const root = await temporaryDirectory();
  try {
    await assert.rejects(extractTarball(Buffer.from('not gzip'), root), /not a valid gzip stream/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an empty archive', async () => {
  const root = await temporaryDirectory();
  try {
    await assert.rejects(extractTarball(makeTarGz([]), root), /contains no files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('honours an aborted signal before writing', async () => {
  const root = await temporaryDirectory();
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(extractTarball(makeTarGz([{ name: 'a/b.txt', content: 'x' }]), root, { signal: controller.signal }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
