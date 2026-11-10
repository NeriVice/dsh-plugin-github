/**
 * Dependency-free `.tar.gz` extraction for repository snapshots.
 *
 * GitHub archives are plain (u|g)star/gnu tar streams. This module reads the
 * stream from an in-memory body, strips the single top-level directory GitHub
 * adds (`owner-repo-sha/`), refuses paths that escape the destination, and skips
 * entries it cannot represent safely (symlinks, devices, hard links).
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;
/** Refuse archives that would unpack beyond this size. */
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

/**
 * Unpack a gzipped tar body into `destination`.
 * @param {Buffer} body complete `.tar.gz` bytes
 * @param {string} destination absolute, existing-or-creatable directory
 * @param {{ signal?: AbortSignal, stripTopLevel?: boolean }} [options]
 * @returns {Promise<{ files: number, directories: number, bytes: number, skipped: string[] }>}
 */
export async function extractTarball(body, destination, options = {}) {
  const { signal, stripTopLevel = true } = options;
  signal?.throwIfAborted();

  let tar;
  try {
    tar = gunzipSync(body, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Downloaded archive is not a valid gzip stream (${reason}).`);
  }

  const root = path.resolve(destination);
  const stats = { files: 0, directories: 0, bytes: 0, skipped: [] };

  let offset = 0;
  let pendingLongName = null;
  let pendingPax = null;

  while (offset + BLOCK <= tar.length) {
    signal?.throwIfAborted();
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    if (isZeroBlock(header)) break;
    if (!hasValidChecksum(header)) {
      throw new Error(`Corrupt archive: bad tar header checksum at byte ${offset - BLOCK}.`);
    }

    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = parseOctal(header.subarray(124, 136));

    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') {
      pendingLongName = readString(data);
      continue;
    }
    if (typeflag === 'K') {
      continue;
    }
    if (typeflag === 'x' || typeflag === 'X') {
      pendingPax = parsePax(data);
      continue;
    }
    if (typeflag === 'g') {
      continue;
    }

    let name = readString(header.subarray(0, 100));
    const prefix = readString(header.subarray(345, 500));
    if (prefix !== '') name = `${prefix}/${name}`;
    if (pendingLongName !== null) {
      name = pendingLongName;
      pendingLongName = null;
    }
    if (pendingPax !== null) {
      if (typeof pendingPax.path === 'string') name = pendingPax.path;
      pendingPax = null;
    }

    const relative = relativeTarget(name, stripTopLevel);
    if (relative === null) {
      stats.skipped.push(name);
      continue;
    }
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(root + path.sep)) {
      stats.skipped.push(name);
      continue;
    }

    const mode = parseOctal(header.subarray(100, 108));

    if (typeflag === '5') {
      await mkdir(target, { recursive: true });
      stats.directories += 1;
      continue;
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '7') {
      // Symlinks, hard links, devices, and FIFOs are not materialized.
      stats.skipped.push(name);
      continue;
    }

    signal?.throwIfAborted();
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    if ((mode & 0o111) !== 0) await chmod(target, mode & 0o777);
    stats.files += 1;
    stats.bytes += data.length;
  }

  if (stats.files === 0 && stats.directories === 0) {
    throw new Error('Downloaded archive contains no files.');
  }
  return stats;
}

/**
 * Strip the archive-wide top directory and reject unsafe names.
 * @param {string} name entry name from the header
 * @param {boolean} stripTopLevel
 * @returns {string | null} safe relative path, or null to skip
 */
function relativeTarget(name, stripTopLevel) {
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (stripTopLevel && parts.length > 1) parts.shift();
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '..' || part.includes('\0') || part.includes('\\'))) return null;
  return parts.join('/');
}

/**
 * @param {Buffer} block
 * @returns {boolean}
 */
function isZeroBlock(block) {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/**
 * @param {Buffer} header
 * @returns {boolean}
 */
function hasValidChecksum(header) {
  const expected = parseOctal(header.subarray(148, 156));
  if (!Number.isFinite(expected)) return false;
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum === expected;
}

/**
 * @param {Buffer} field octal ASCII field with optional space/NUL padding
 * @returns {number}
 */
function parseOctal(field) {
  const text = readString(field).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * @param {Buffer} field NUL-terminated ASCII field
 * @returns {string}
 */
function readString(field) {
  const end = field.indexOf(0);
  const slice = end === -1 ? field : field.subarray(0, end);
  return slice.toString('utf8').trim();
}

/**
 * Parse pax extended-header records (`<length> <key>=<value>\n`).
 * @param {Buffer} data record bytes
 * @returns {Record<string, string>}
 */
function parsePax(data) {
  /** @type {Record<string, string>} */
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}
