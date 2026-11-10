/**
 * Git integration for repository checkouts: detect the binary, clone with the
 * token passed through the environment instead of the command line, and fall
 * back to a snapshot when git is unavailable.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** @type {Promise<boolean> | undefined} */
let gitAvailable;

/**
 * Whether a working `git` executable is on PATH. Cached for the process.
 * @returns {Promise<boolean>}
 */
export function hasGit() {
  gitAvailable ??= run('git', ['--version'], { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  return gitAvailable;
}

/**
 * Shallow-clone a repository.
 *
 * The credential travels in the process environment (`GIT_CONFIG_*` extra
 * header) rather than argv, so it does not appear in `ps` output.
 * @param {{ url: string, destination: string, ref?: string, token?: string | null, signal?: AbortSignal, timeoutMs?: number }} options
 * @returns {Promise<void>}
 */
export async function cloneRepository({ url, destination, ref, token, signal, timeoutMs = 180_000 }) {
  const args = ['clone', '--depth', '1', '--single-branch', '--no-tags'];
  if (typeof ref === 'string' && ref.trim() !== '') args.push('--branch', ref.trim());
  args.push(url, destination);

  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
  };
  if (typeof token === 'string' && token !== '') {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.https://github.com/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }

  try {
    await run('git', args, {
      env,
      timeout: timeoutMs,
      signal,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : '';
    const detail = stderr.trim() === '' ? (error instanceof Error ? error.message : String(error)) : stderr.trim();
    throw new Error(`git clone failed: ${sanitize(detail, token)}`);
  }
}

/**
 * Remove a credential from a diagnostic string before it reaches the model.
 * @param {string} text
 * @param {string | null | undefined} token
 * @returns {string}
 */
function sanitize(text, token) {
  let value = text;
  if (typeof token === 'string' && token !== '') {
    value = value.split(token).join('***');
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    if (basic !== '') value = value.split(basic).join('***');
  }
  return value.replace(/https:\/\/[^@\s/]+@/g, 'https://');
}
