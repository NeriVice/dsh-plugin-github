/**
 * Deterministic tar/tar.gz construction for extraction tests.
 */
import { gzipSync } from 'node:zlib';

/**
 * Build a ustar archive from entries.
 * @param {{ name: string, content?: string | Buffer, type?: '0' | '2' | '5' | 'L' | 'x', mode?: number, linkname?: string }[]} entries
 * @returns {Buffer}
 */
export function makeTar(entries) {
  /** @type {Buffer[]} */
  const blocks = [];
  for (const entry of entries) {
    const content = entry.content === undefined ? Buffer.alloc(0) : Buffer.from(entry.content);
    const type = entry.type ?? '0';
    blocks.push(header(entry.name, { size: content.length, type, mode: entry.mode ?? 0o644, linkname: entry.linkname ?? '' }));
    if (content.length > 0) {
      blocks.push(content);
      const padding = 512 - (content.length % 512);
      if (padding !== 512) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/**
 * @param {{ name: string, content?: string | Buffer, type?: '0' | '2' | '5' | 'L' | 'x', mode?: number, linkname?: string }[]} entries
 * @returns {Buffer}
 */
export function makeTarGz(entries) {
  return gzipSync(makeTar(entries));
}

/**
 * @param {string} name
 * @param {{ size: number, type: string, mode: number, linkname: string }} options
 * @returns {Buffer}
 */
function header(name, options) {
  const block = Buffer.alloc(512);
  writeField(block, 0, 100, name);
  writeOctal(block, 100, 8, options.mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, options.size);
  writeOctal(block, 136, 12, Math.floor(Date.now() / 1000));
  block.fill(0x20, 148, 156);
  writeField(block, 156, 1, options.type);
  writeField(block, 157, 100, options.linkname);
  writeField(block, 257, 6, 'ustar');
  writeField(block, 263, 2, '00');

  let checksum = 0;
  for (const byte of block) checksum += byte;
  writeOctal(block, 148, 8, checksum);
  return block;
}

/**
 * @param {Buffer} block
 * @param {number} offset
 * @param {number} length
 * @param {string} value
 */
function writeField(block, offset, length, value) {
  Buffer.from(value, 'utf8').copy(block, offset, 0, Math.min(length, Buffer.byteLength(value)));
}

/**
 * @param {Buffer} block
 * @param {number} offset
 * @param {number} length
 * @param {number} value
 */
function writeOctal(block, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  block.write(text, offset, length - 1, 'ascii');
  block.write('\0', offset + length - 1, 'ascii');
}
