/**
 * Repository reference parsing and model-facing formatting helpers.
 */

/**
 * Accept `owner/name`, a GitHub URL, or an SSH remote and return the canonical parts.
 * @param {string} input repository reference from the model
 * @returns {{ owner: string, name: string, fullName: string }}
 */
export function parseRepo(input) {
  if (typeof input !== 'string') throw new Error('repo must be a string such as "owner/name"');
  let value = input.trim();
  if (value === '') throw new Error('repo must not be empty; pass "owner/name"');

  value = value
    .replace(/^git@github\.com:/i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (match === null) {
    throw new Error(`invalid repo "${input}": expected "owner/name" (for example "deepseek-ai/deepseek-harness")`);
  }
  const [, owner, name] = match;
  return { owner, name, fullName: `${owner}/${name}` };
}

/**
 * Human-readable byte size.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * One-line description of a repository for tool output.
 * @param {{ fullName: string, private?: boolean, archived?: boolean, fork?: boolean, description?: string, stars?: number, language?: string, updatedAt?: string }} repo
 * @returns {string}
 */
export function describeRepo(repo) {
  const flags = [
    repo.private === true ? 'private' : 'public',
    repo.archived === true ? 'archived' : '',
    repo.fork === true ? 'fork' : '',
  ].filter((flag) => flag !== '');
  const extras = [
    typeof repo.language === 'string' && repo.language !== '' ? repo.language : '',
    typeof repo.stars === 'number' ? `★ ${repo.stars}` : '',
    typeof repo.updatedAt === 'string' && repo.updatedAt !== '' ? `updated ${repo.updatedAt.slice(0, 10)}` : '',
  ].filter((part) => part !== '');
  const description = typeof repo.description === 'string' && repo.description.trim() !== '' ? ` — ${repo.description.trim()}` : '';
  return `${repo.fullName} [${flags.join(', ')}]${extras.length === 0 ? '' : ` (${extras.join(', ')})`}${description}`;
}

/**
 * Shorten free text for a table-like line.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
