/**
 * dsh-plugin-github — connect GitHub repositories to a dsh Session.
 *
 * Registers global tools that talk to the GitHub REST API with a personal
 * access token: list and search repositories, inspect one, read issues and pull
 * requests, open an issue, and bring a repository into the workspace (git clone
 * when git is available, otherwise a snapshot of the default branch).
 *
 * The module is dependency-free so it can be loaded straight from the profile
 * patch by file URL, without a package install.
 */
import path from 'node:path';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';

import { DEFAULT_BASE_URL, GitHubClient } from './src/client.js';
import { cloneRepository, hasGit } from './src/git.js';
import { describeRepo, formatBytes, parseRepo } from './src/repo.js';
import { normalizeSchema } from './src/schema.js';
import { resetTokenCache } from './src/token.js';
import { extractTarball } from './src/tar.js';

/** Stable loader identity. */
export const name = 'github-repos';

/**
 * Services used by the tools. `workingDirectory` resolves the Session's
 * directory for `github_clone_repo`; it is part of the dsh base bundle.
 */
export const inject = ['tools', 'workingDirectory'];

const DEFAULT_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 300_000;

/**
 * Register the GitHub tools.
 * @param {{ tools: { register(definition: object): () => void }, workingDirectory?: { ensure(agent: unknown, signal: AbortSignal): Promise<string> } }} ctx
 * @param {{ token?: string, baseUrl?: string, timeoutMs?: number }} [config]
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config);

  for (const definition of buildTools(ctx, options)) {
    ctx.tools.register(definition);
  }
}

/**
 * Validate the profile patch configuration once at load time.
 * @param {unknown} config
 * @returns {{ token?: string, baseUrl: string, timeoutMs: number }}
 */
function normalizeConfig(config) {
  if (config === undefined || config === null) return { baseUrl: DEFAULT_BASE_URL, timeoutMs: DEFAULT_TIMEOUT_MS };
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('dsh-plugin-github: config must be a mapping (token, baseUrl, timeoutMs)');
  }
  const raw = /** @type {{ token?: unknown, baseUrl?: unknown, timeoutMs?: unknown }} */ (config);
  const token = raw.token === undefined || raw.token === null ? undefined : String(raw.token).trim();
  if (token !== undefined && token === '') throw new Error('dsh-plugin-github: config.token must not be empty');
  const baseUrl = raw.baseUrl === undefined ? DEFAULT_BASE_URL : String(raw.baseUrl);
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`dsh-plugin-github: config.baseUrl is not a URL: ${baseUrl}`);
  }
  const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(raw.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('dsh-plugin-github: config.timeoutMs must be a positive number');
  }
  return { ...(token === undefined ? {} : { token }), baseUrl, timeoutMs };
}

/**
 * @param {Parameters<typeof apply>[0]} ctx
 * @param {{ token?: string, baseUrl: string, timeoutMs: number }} options
 * @returns {object[]}
 */
function buildTools(ctx, options) {
  /** @returns {GitHubClient} a client with the credential resolved at call time */
  const clientFor = () => {
    const resolved = GitHubClient.from(options);
    return new GitHubClient({
      token: resolved.token,
      tokenSource: resolved.tokenSource,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
    });
  };

  return [
    accountTool(clientFor),
    listReposTool(clientFor),
    getRepoTool(clientFor),
    listIssuesTool(clientFor),
    createIssueTool(clientFor),
    cloneTool(ctx, clientFor),
  ].map(normalizeDefinition);
}

/**
 * Convert author-style schemas to raw JSON Schema the registry accepts.
 * @param {object} definition
 * @returns {object}
 */
function normalizeDefinition(definition) {
  return {
    ...definition,
    parameters: normalizeSchema(definition.parameters),
    output: { ...definition.output, schema: normalizeSchema(definition.output.schema) },
  };
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {(signal: AbortSignal) => GitHubClient} clientFor
 * @returns {object}
 */
function accountTool(clientFor) {
  return {
    name: 'github_account',
    description:
      'Check the GitHub identity behind this Session: login, name, token source, OAuth scopes, and remaining rate limit. '
      + 'Use it first when GitHub calls fail, to tell a missing token from a missing permission.',
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Re-read the credential from the environment, token files, or the gh CLI instead of the 30-second cache.',
        },
      },
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          authenticated: { type: 'boolean', required: true },
          login: { type: 'string', required: true },
          name: { type: 'string', required: true },
          tokenSource: { type: 'string', required: true },
          scopes: { type: 'array', required: true, items: { type: 'string' } },
          publicRepos: { type: 'integer', required: true },
          privateRepos: { type: 'integer', required: true },
          rateLimit: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              limit: { type: 'integer', required: true },
              remaining: { type: 'integer', required: true },
              resetAt: { type: 'string', required: true },
            },
          },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          value.authenticated
            ? `GitHub: authenticated as ${value.login}${value.name === '' ? '' : ` (${value.name})`} — token from ${value.tokenSource}`
            : `GitHub: not authenticated — ${value.note}`,
        ];
        if (value.authenticated) {
          lines.push(`Repositories: ${value.publicRepos} public, ${value.privateRepos} private`);
          lines.push(`Scopes: ${value.scopes.length === 0 ? '(none reported; fine-grained tokens report none)' : value.scopes.join(', ')}`);
        }
        lines.push(`Rate limit: ${value.rateLimit.remaining}/${value.rateLimit.limit} remaining${value.rateLimit.resetAt === '' ? '' : `, resets ${shortTimestamp(value.rateLimit.resetAt)}`}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      if (args.refresh === true) resetTokenCache();
      const client = clientFor();
      if (!client.authenticated) {
        const { data, headers } = await client.json('/rate_limit', { signal: exec.signal });
        return {
          authenticated: false,
          login: '',
          name: '',
          tokenSource: client.tokenSource,
          scopes: [],
          publicRepos: 0,
          privateRepos: 0,
          rateLimit: rateLimitFrom(data, headers),
          note: 'no token configured; set GITHUB_TOKEN, write one to ~/.dsh/github-token, or run `gh auth login`',
        };
      }
      const { data, headers } = await client.json('/user', { signal: exec.signal });
      const user = /** @type {Record<string, unknown>} */ (data);
      return {
        authenticated: true,
        login: asString(user.login),
        name: asString(user.name),
        tokenSource: client.tokenSource,
        scopes: splitScopes(headers.get('x-oauth-scopes')),
        publicRepos: asNumber(user.public_repos),
        privateRepos: asNumber(user.total_private_repos ?? user.owned_private_repos),
        rateLimit: GitHubClient.rateLimit(headers),
        note: '',
      };
    },
  };
}

/**
 * @param {(signal: AbortSignal) => GitHubClient} clientFor
 * @returns {object}
 */
function listReposTool(clientFor) {
  return {
    name: 'github_list_repos',
    description:
      'List GitHub repositories visible to the token: the authenticated user\'s own, collaborator, and organization repositories, '
      + 'or one owner\'s repositories. Sorted by last update by default and filterable by name or description, so it doubles as a search.',
    parameters: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'Optional user or organization login. Omit to list everything the token can reach.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive text matched against the repository name, full name, and description.',
        },
        visibility: {
          type: 'string',
          enum: ['all', 'public', 'private'],
          description: 'Visibility filter; defaults to all.',
        },
        includeForks: { type: 'boolean', description: 'Include forks; defaults to false.' },
        includeArchived: { type: 'boolean', description: 'Include archived repositories; defaults to true.' },
        sort: {
          type: 'string',
          enum: ['updated', 'pushed', 'full_name'],
          description: 'Sort order; defaults to updated.',
        },
        limit: { type: 'integer', description: 'Maximum repositories to return, 1-100; defaults to 30.' },
      },
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          owner: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          repos: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fullName: { type: 'string', required: true },
                name: { type: 'string', required: true },
                owner: { type: 'string', required: true },
                private: { type: 'boolean', required: true },
                fork: { type: 'boolean', required: true },
                archived: { type: 'boolean', required: true },
                description: { type: 'string', required: true },
                defaultBranch: { type: 'string', required: true },
                language: { type: 'string', required: true },
                stars: { type: 'integer', required: true },
                forks: { type: 'integer', required: true },
                openIssues: { type: 'integer', required: true },
                updatedAt: { type: 'string', required: true },
                cloneUrl: { type: 'string', required: true },
                htmlUrl: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.repos.length === 0) {
          return [{ type: 'text', text: `No repositories matched${value.owner === '' ? '' : ` for ${value.owner}`}.` }];
        }
        const lines = value.repos.map((repo) => `- ${describeRepo(repo)}`);
        lines.unshift(`${value.repos.length} of ${value.total} repositories:`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const client = clientFor();
      const limit = clampLimit(args.limit, 30);
      const visibility = args.visibility ?? 'all';
      const sort = args.sort ?? 'updated';
      const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const fetchLimit = Math.min(100, limit * 3);

      const repositories = owner === ''
        ? await client.list('/user/repos', {
          query: { affiliation: 'owner,collaborator,organization_member', sort, direction: 'desc' },
          limit: fetchLimit,
          signal: exec.signal,
        })
        : await repositoriesOf(client, owner, sort, fetchLimit, exec.signal);

      const matched = repositories
        .map((entry) => toRepoSummary(entry))
        .filter((repo) => visibility === 'all' || (visibility === 'private' ? repo.private : !repo.private))
        .filter((repo) => args.includeForks === true || !repo.fork)
        .filter((repo) => args.includeArchived !== false || !repo.archived)
        .filter((repo) => query === ''
          || repo.fullName.toLowerCase().includes(query)
          || repo.name.toLowerCase().includes(query)
          || repo.description.toLowerCase().includes(query));

      return { owner, total: matched.length, repos: matched.slice(0, limit) };
    },
  };
}

/**
 * @param {(signal: AbortSignal) => GitHubClient} clientFor
 * @returns {object}
 */
function getRepoTool(clientFor) {
  return {
    name: 'github_get_repo',
    description: 'Read the details of one GitHub repository: description, default branch, language, stars, open issues, topics, and clone URLs.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as "owner/name", a github.com URL, or an SSH remote.' },
      },
      required: ['repo'],
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fullName: { type: 'string', required: true },
          description: { type: 'string', required: true },
          homepage: { type: 'string', required: true },
          private: { type: 'boolean', required: true },
          fork: { type: 'boolean', required: true },
          archived: { type: 'boolean', required: true },
          defaultBranch: { type: 'string', required: true },
          language: { type: 'string', required: true },
          topics: { type: 'array', required: true, items: { type: 'string' } },
          stars: { type: 'integer', required: true },
          forks: { type: 'integer', required: true },
          openIssues: { type: 'integer', required: true },
          watchers: { type: 'integer', required: true },
          sizeKb: { type: 'integer', required: true },
          license: { type: 'string', required: true },
          createdAt: { type: 'string', required: true },
          updatedAt: { type: 'string', required: true },
          pushedAt: { type: 'string', required: true },
          cloneUrl: { type: 'string', required: true },
          sshUrl: { type: 'string', required: true },
          htmlUrl: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [`${value.fullName} — ${value.description === '' ? '(no description)' : value.description}`];
        lines.push(`State: ${value.private ? 'private' : 'public'}${value.archived ? ', archived' : ''}${value.fork ? ', fork' : ''}`
          + ` · default branch ${value.defaultBranch} · ${formatBytes(value.sizeKb * 1024)}`);
        if (value.language !== '' || value.topics.length > 0) {
          lines.push(`Stack: ${[value.language, ...value.topics].filter((part) => part !== '').join(', ')}`);
        }
        lines.push(`Stars ${value.stars} · forks ${value.forks} · open issues ${value.openIssues} · watchers ${value.watchers}`);
        lines.push(`Updated ${value.updatedAt} · pushed ${value.pushedAt} · created ${value.createdAt}`);
        if (value.license !== '') lines.push(`License: ${value.license}`);
        lines.push(`Clone: ${value.cloneUrl}`);
        if (value.homepage !== '') lines.push(`Homepage: ${value.homepage}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const ref = parseRepo(args.repo);
      const client = clientFor();
      const { data } = await client.json(`/repos/${ref.fullName}`, { signal: exec.signal });
      return toRepoDetail(data);
    },
  };
}

/**
 * @param {(signal: AbortSignal) => GitHubClient} clientFor
 * @returns {object}
 */
function listIssuesTool(clientFor) {
  return {
    name: 'github_list_issues',
    description: 'List issues and pull requests of a repository, newest first, optionally filtered by state, labels, or kind.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as "owner/name".' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state; defaults to open.' },
        kind: { type: 'string', enum: ['all', 'issue', 'pull'], description: 'Restrict to issues, pull requests, or both; defaults to all.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Only entries carrying every listed label.' },
        limit: { type: 'integer', description: 'Maximum entries to return, 1-100; defaults to 20.' },
      },
      required: ['repo'],
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                state: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                author: { type: 'string', required: true },
                labels: { type: 'array', required: true, items: { type: 'string' } },
                comments: { type: 'integer', required: true },
                draft: { type: 'boolean', required: true },
                createdAt: { type: 'string', required: true },
                updatedAt: { type: 'string', required: true },
                htmlUrl: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.items.length === 0) return [{ type: 'text', text: `No matching issues or pull requests in ${value.repo}.` }];
        const lines = value.items.map((item) => {
          const label = item.kind === 'pull' ? `PR #${item.number}${item.draft ? ' (draft)' : ''}` : `#${item.number}`;
          const labels = item.labels.length === 0 ? '' : ` [${item.labels.join(', ')}]`;
          return `- ${label} ${item.title} — ${item.state}, ${item.author}${labels}`;
        });
        lines.unshift(`${value.items.length} of ${value.total} entries in ${value.repo}:`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const ref = parseRepo(args.repo);
      const client = clientFor();
      const limit = clampLimit(args.limit, 20);
      const state = args.state ?? 'open';
      const kind = args.kind ?? 'all';
      const labels = Array.isArray(args.labels) ? args.labels.filter((label) => typeof label === 'string' && label.trim() !== '') : [];
      const entries = await client.list(`/repos/${ref.fullName}/issues`, {
        query: { state, ...(labels.length === 0 ? {} : { labels: labels.join(',') }) },
        limit: Math.min(100, limit * 2),
        signal: exec.signal,
      });
      const items = entries
        .map((entry) => toIssueSummary(entry))
        .filter((item) => kind === 'all' || (kind === 'pull' ? item.kind === 'pull' : item.kind === 'issue'));
      return { repo: ref.fullName, total: items.length, items: items.slice(0, limit) };
    },
  };
}

/**
 * @param {(signal: AbortSignal) => GitHubClient} clientFor
 * @returns {object}
 */
function createIssueTool(clientFor) {
  return {
    name: 'github_create_issue',
    description: 'Open a new issue in a GitHub repository. Requires a token with issue write access (classic `repo`, or fine-grained Issues: read and write).',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as "owner/name".' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body in Markdown.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach.' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'Logins to assign.' },
      },
      required: ['repo', 'title'],
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          number: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          state: { type: 'string', required: true },
          htmlUrl: { type: 'string', required: true },
          createdAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Opened issue #${value.number} "${value.title}" (${value.state}): ${value.htmlUrl}` }],
    },
    async execute(args, exec) {
      const ref = parseRepo(args.repo);
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (title === '') throw new Error('title must not be empty');
      const client = clientFor();
      const body = { title };
      if (typeof args.body === 'string' && args.body.trim() !== '') body.body = args.body;
      if (Array.isArray(args.labels) && args.labels.length > 0) body.labels = args.labels;
      if (Array.isArray(args.assignees) && args.assignees.length > 0) body.assignees = args.assignees;
      const { data } = await client.json(`/repos/${ref.fullName}/issues`, { method: 'POST', body, signal: exec.signal });
      const issue = /** @type {Record<string, unknown>} */ (data);
      return {
        number: asNumber(issue.number),
        title: asString(issue.title),
        state: asString(issue.state),
        htmlUrl: asString(issue.html_url),
        createdAt: asString(issue.created_at),
      };
    },
  };
}

/**
 * @param {Parameters<typeof apply>[0]} ctx
 * @param {(signal: AbortSignal) => GitHubClient} clientFor
 * @returns {object}
 */
function cloneTool(ctx, clientFor) {
  return {
    name: 'github_clone_repo',
    description:
      'Bring a GitHub repository into the workspace. Uses `git clone --depth 1` when git is installed; otherwise downloads a snapshot '
      + 'of the default branch (or the requested ref) as a tarball and extracts it. Refuses to write into a non-empty directory unless overwrite is true.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository as "owner/name".' },
        ref: { type: 'string', description: 'Branch, tag, or commit to check out. Defaults to the repository default branch.' },
        destination: {
          type: 'string',
          description: 'Directory to create, relative to the Session working directory. Defaults to the repository name.',
        },
        overwrite: { type: 'boolean', description: 'Allow an existing non-empty destination. Defaults to false.' },
      },
      required: ['repo'],
    },
    timeoutMs: CLONE_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { type: 'string', required: true },
          path: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          ref: { type: 'string', required: true },
          files: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          skipped: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Cloned ${value.repo} into ${value.path} (${value.mode}${value.ref === '' ? '' : `, ref ${value.ref}`}, `
          + `${value.files} files, ${formatBytes(value.bytes)}).`
          + (value.note === '' ? '' : ` ${value.note}`)
          + (value.skipped.length === 0 ? '' : ` Skipped ${value.skipped.length} unsupported entr${value.skipped.length === 1 ? 'y' : 'ies'}.`),
      }],
    },
    async execute(args, exec) {
      const ref = parseRepo(args.repo);
      const client = clientFor();
      const cwd = await resolveWorkingDirectory(ctx, exec);
      const destination = typeof args.destination === 'string' && args.destination.trim() !== ''
        ? args.destination.trim()
        : ref.name;
      if (path.isAbsolute(destination)) throw new Error('destination must be relative to the Session working directory');
      const target = path.resolve(cwd, destination);
      if (target !== cwd && !target.startsWith(cwd + path.sep)) {
        throw new Error('destination must stay inside the Session working directory');
      }
      if (target === cwd) throw new Error('destination must name a new directory, not the working directory itself');

      await mkdir(cwd, { recursive: true });
      const existing = await directoryEntries(target);
      if (existing.length > 0) {
        if (args.overwrite !== true) {
          throw new Error(`${displayPath(cwd, target)} already exists and is not empty; pass overwrite: true to replace its contents`);
        }
        await rm(target, { recursive: true, force: true });
      }

      const git = await hasGit();
      if (git) {
        await cloneRepository({
          url: `https://github.com/${ref.fullName}.git`,
          destination: target,
          ref: typeof args.ref === 'string' ? args.ref : undefined,
          token: client.token,
          signal: exec.signal,
          timeoutMs: CLONE_TIMEOUT_MS,
        });
        const files = await countFiles(target);
        return {
          repo: ref.fullName,
          path: displayPath(cwd, target),
          mode: 'git',
          ref: typeof args.ref === 'string' ? args.ref : '',
          files: files.count,
          bytes: files.bytes,
          skipped: [],
          note: '',
        };
      }

      if (!client.authenticated) {
        throw new Error(
          'git is not installed, so this tool must download a snapshot, which needs a GitHub token for rate limits and private repositories. '
            + 'Set GITHUB_TOKEN or write a token to ~/.dsh/github-token, or install git and retry.',
        );
      }

      const body = await client.download(`/repos/${ref.fullName}/tarball${typeof args.ref === 'string' && args.ref.trim() !== '' ? `/${args.ref}` : ''}`, {
        signal: exec.signal,
        timeoutMs: CLONE_TIMEOUT_MS,
      });
      const stats = await extractTarball(body, target, { signal: exec.signal });
      return {
        repo: ref.fullName,
        path: displayPath(cwd, target),
        mode: 'snapshot',
        ref: typeof args.ref === 'string' ? args.ref : '',
        files: stats.files,
        bytes: stats.bytes,
        skipped: stats.skipped.slice(0, 20),
        note: 'git is not installed: this is a snapshot without history, so commits and branches are unavailable.',
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mapping helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} data repository payload
 * @returns {{ fullName: string, name: string, owner: string, private: boolean, fork: boolean, archived: boolean, description: string, defaultBranch: string, language: string, stars: number, forks: number, openIssues: number, updatedAt: string, cloneUrl: string, htmlUrl: string }}
 */
function toRepoSummary(data) {
  const repo = asRecord(data);
  const owner = asRecord(repo.owner);
  return {
    fullName: asString(repo.full_name),
    name: asString(repo.name),
    owner: asString(owner.login),
    private: repo.private === true,
    fork: repo.fork === true,
    archived: repo.archived === true,
    description: asString(repo.description),
    defaultBranch: asString(repo.default_branch),
    language: asString(repo.language),
    stars: asNumber(repo.stargazers_count),
    forks: asNumber(repo.forks_count),
    openIssues: asNumber(repo.open_issues_count),
    updatedAt: asString(repo.updated_at),
    cloneUrl: asString(repo.clone_url),
    htmlUrl: asString(repo.html_url),
  };
}

/**
 * @param {unknown} data repository payload
 * @returns {object} detail shape declared by github_get_repo
 */
function toRepoDetail(data) {
  const repo = asRecord(data);
  const license = asRecord(repo.license);
  return {
    fullName: asString(repo.full_name),
    description: asString(repo.description),
    homepage: asString(repo.homepage),
    private: repo.private === true,
    fork: repo.fork === true,
    archived: repo.archived === true,
    defaultBranch: asString(repo.default_branch),
    language: asString(repo.language),
    topics: Array.isArray(repo.topics) ? repo.topics.filter((topic) => typeof topic === 'string') : [],
    stars: asNumber(repo.stargazers_count),
    forks: asNumber(repo.forks_count),
    openIssues: asNumber(repo.open_issues_count),
    watchers: asNumber(repo.watchers_count),
    sizeKb: asNumber(repo.size),
    license: asString(license?.spdx_id) === 'NOASSERTION' ? asString(license?.name) : asString(license?.spdx_id),
    createdAt: asString(repo.created_at),
    updatedAt: asString(repo.updated_at),
    pushedAt: asString(repo.pushed_at),
    cloneUrl: asString(repo.clone_url),
    sshUrl: asString(repo.ssh_url),
    htmlUrl: asString(repo.html_url),
  };
}

/**
 * @param {unknown} data issue payload (issues endpoint returns pull requests too)
 * @returns {{ number: number, title: string, state: string, kind: 'issue' | 'pull', author: string, labels: string[], comments: number, draft: boolean, createdAt: string, updatedAt: string, htmlUrl: string }}
 */
function toIssueSummary(data) {
  const issue = asRecord(data);
  const user = asRecord(issue.user);
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => (typeof label === 'string' ? label : asString(asRecord(label).name))).filter((label) => label !== '')
    : [];
  return {
    number: asNumber(issue.number),
    title: asString(issue.title),
    state: asString(issue.state),
    kind: issue.pull_request === undefined ? 'issue' : 'pull',
    author: asString(user.login),
    labels,
    comments: asNumber(issue.comments),
    draft: issue.draft === true,
    createdAt: asString(issue.created_at),
    updatedAt: asString(issue.updated_at),
    htmlUrl: asString(issue.html_url),
  };
}

/**
 * Fetch one owner's repositories, tolerating user and organization logins and
 * preferring `/user/repos` so a user's private repositories are included.
 * @param {GitHubClient} client
 * @param {string} owner
 * @param {string} sort
 * @param {number} limit
 * @param {AbortSignal} signal
 * @returns {Promise<unknown[]>}
 */
async function repositoriesOf(client, owner, sort, limit, signal) {
  const query = { sort, direction: 'desc' };
  const login = await currentLogin(client, signal);
  if (login !== '' && login.toLowerCase() === owner.toLowerCase()) {
    return client.list('/user/repos', { query: { ...query, affiliation: 'owner' }, limit, signal });
  }
  try {
    return await client.list(`/users/${encodeURIComponent(owner)}/repos`, { query, limit, signal });
  } catch (error) {
    if (!(error instanceof Error && 'status' in error && error.status === 404)) throw error;
    return client.list(`/orgs/${encodeURIComponent(owner)}/repos`, { query, limit, signal });
  }
}

/** @type {WeakMap<GitHubClient, string>} */
const loginCache = new WeakMap();

/**
 * Authenticated login for a client, fetched at most once per client instance.
 * @param {GitHubClient} client
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function currentLogin(client, signal) {
  if (!client.authenticated) return '';
  const cached = loginCache.get(client);
  if (cached !== undefined) return cached;
  const { data } = await client.json('/user', { signal });
  const login = asString(asRecord(data)?.login);
  loginCache.set(client, login);
  return login;
}

/**
 * @param {unknown} data `/rate_limit` payload
 * @param {Headers} headers response headers
 * @returns {{ limit: number, remaining: number, resetAt: string }}
 */
function rateLimitFrom(data, headers) {
  const core = asRecord(asRecord(data).resources)?.core;
  const record = asRecord(core);
  const reset = asNumber(record?.reset);
  const fromHeaders = GitHubClient.rateLimit(headers);
  if (fromHeaders.limit > 0) return fromHeaders;
  return {
    limit: asNumber(record?.limit),
    remaining: asNumber(record?.remaining),
    resetAt: reset > 0 ? new Date(reset * 1000).toISOString() : '',
  };
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {string | null} header comma-separated scope header
 * @returns {string[]}
 */
function splitScopes(header) {
  if (typeof header !== 'string' || header.trim() === '') return [];
  return header.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '');
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function clampLimit(value, fallback) {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(1, Math.min(100, parsed));
}

/**
 * Resolve the Session working directory, falling back to the process directory.
 * @param {Parameters<typeof apply>[0]} ctx
 * @param {{ agent?: unknown, signal: AbortSignal }} exec
 * @returns {Promise<string>}
 */
async function resolveWorkingDirectory(ctx, exec) {
  const service = ctx.workingDirectory;
  if (service !== undefined && service !== null && typeof service.ensure === 'function' && exec.agent !== undefined) {
    try {
      const cwd = await service.ensure(exec.agent, exec.signal);
      if (typeof cwd === 'string' && cwd !== '') return cwd;
    } catch (error) {
      if (exec.signal.aborted) throw error;
    }
  }
  return process.cwd();
}

/**
 * @param {string} target absolute directory
 * @returns {Promise<string[]>}
 */
async function directoryEntries(target) {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error(`${target} exists and is not a directory`);
    return (await readdir(target)).filter((entry) => entry !== '.git');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Recursively count files and bytes, bounded so a huge checkout cannot stall a turn.
 * @param {string} root
 * @returns {Promise<{ count: number, bytes: number }>}
 */
async function countFiles(root) {
  let count = 0;
  let bytes = 0;
  /** @type {string[]} */
  const queue = [root];
  while (queue.length > 0 && count < 50_000) {
    const current = /** @type {string} */ (queue.shift());
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      count += 1;
      try {
        bytes += (await stat(absolute)).size;
      } catch {
        // Ignore files that vanish mid-scan.
      }
    }
  }
  return { count, bytes };
}

/**
 * @param {string} cwd
 * @param {string} target
 * @returns {string}
 */
function displayPath(cwd, target) {
  const relative = path.relative(cwd, target);
  return relative === '' ? '.' : relative;
}

/**
 * Render an ISO timestamp without the redundant milliseconds.
 * @param {string} value ISO 8601 string
 * @returns {string}
 */
function shortTimestamp(value) {
  return value.replace(/\.\d{3}Z$/, 'Z');
}
