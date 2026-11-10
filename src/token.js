/**
 * GitHub credential discovery.
 *
 * Order: plugin config -> GITHUB_TOKEN -> GH_TOKEN -> token files -> `gh auth token`.
 * The result is cached briefly so a token written by hand is picked up without a
 * profile reload, while repeated tool calls in one turn do not re-read the disk.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Files checked in order, relative to the home directory. */
export const TOKEN_FILES = ['.dsh/github-token', '.config/dsh/github-token', '.github-token'];

/** Environment variables checked in order. */
export const TOKEN_ENV = ['GITHUB_TOKEN', 'GH_TOKEN'];

const CACHE_TTL_MS = 30_000;

/** @type {{ token: string | null, source: string, at: number } | null} */
let cache = null;

/**
 * Resolve the token to use for GitHub requests.
 * @param {{ token?: string }} [config] plugin config from the profile patch.
 * @param {{ force?: boolean }} [options] bypass the cache (used by the status tool).
 * @returns {{ token: string | null, source: string }}
 */
export function resolveToken(config = {}, { force = false } = {}) {
  if (!force && cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
    return { token: cache.token, source: cache.source };
  }
  const resolved = resolveUncached(config);
  cache = { ...resolved, at: Date.now() };
  return resolved;
}

/** Forget the cached credential (tests and manual refresh). */
export function resetTokenCache() {
  cache = null;
}

/**
 * @param {{ token?: string }} config
 * @returns {{ token: string | null, source: string }}
 */
function resolveUncached(config) {
  const configured = typeof config.token === 'string' ? config.token.trim() : '';
  if (configured !== '') return { token: configured, source: 'plugin config' };

  for (const name of TOKEN_ENV) {
    const value = (process.env[name] ?? '').trim();
    if (value !== '') return { token: value, source: `environment ${name}` };
  }

  for (const relative of TOKEN_FILES) {
    const file = join(homedir(), relative);
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value !== '') return { token: value, source: `file ${file}` };
    } catch {
      // Missing or unreadable: try the next candidate.
    }
  }

  const fromGh = ghToken();
  if (fromGh !== null) return { token: fromGh, source: 'gh auth token' };

  return { token: null, source: 'none' };
}

/**
 * Read a token from the GitHub CLI when it is installed and authenticated.
 * @returns {string | null}
 */
function ghToken() {
  try {
    const output = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output === '' ? null : output;
  } catch {
    return null;
  }
}
