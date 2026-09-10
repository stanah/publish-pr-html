#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { GitHubClient, splitRepo } from '../src/lib/github.mjs';
import { resolveToken } from '../src/cli/auth.mjs';
import { DEFAULT_WORKFLOW_FILE, publish } from '../src/cli/publish.mjs';
import { DEFAULT_RELAY_TAG, setup } from '../src/cli/setup.mjs';
import { DEFAULT_MAX_HTML_BYTES } from '../src/lib/validate.mjs';

const USAGE = `publish-pr-html - publish a generated HTML file to a PR as a non-zipped Actions artifact

Usage:
  publish-pr-html --repo OWNER/REPO --pr N --head-sha FULL_SHA --file FILE [options]
  publish-pr-html setup --repo OWNER/REPO [--tag TAG]

Publish options:
  --workflow FILE    workflow file name in the target repo (default: ${DEFAULT_WORKFLOW_FILE})
  --release-id ID    relay draft release id (default: $PR_HTML_RELEASE_ID or the repo variable)
  --max-bytes N      HTML size limit in bytes (default: ${DEFAULT_MAX_HTML_BYTES})
  --no-wait          return right after the dispatch is accepted
  --timeout SEC      how long to wait for the run (default: 900)
  --json             print the result as JSON on stdout

Auth: GITHUB_TOKEN, GH_TOKEN, or \`gh auth token\`.
Exit codes: 0 published, 2 skipped, 3 timeout, 1 error.
`;

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      'head-sha': { type: 'string' },
      file: { type: 'string' },
      workflow: { type: 'string', default: DEFAULT_WORKFLOW_FILE },
      ref: { type: 'string' },
      'release-id': { type: 'string' },
      'max-bytes': { type: 'string' },
      'no-wait': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '900' },
      json: { type: 'boolean', default: false },
      tag: { type: 'string', default: DEFAULT_RELAY_TAG },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return Promise.resolve(0);
  }
  const command = positionals[0] ?? 'publish';
  if (!values.repo) throw new Error('--repo OWNER/REPO is required');
  const repo = splitRepo(values.repo);
  const gh = new GitHubClient({ token: resolveToken(), apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com' });
  const log = (line) => process.stderr.write(`${line}\n`);

  if (command === 'setup') {
    return setup({ gh, repo, tag: values.tag, log }).then((result) => {
      process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `release_id=${result.release_id}\nrelease_url=${result.release_url}\nvariable_set=${result.variable_set}\n`);
      return 0;
    });
  }
  if (command !== 'publish') throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  for (const key of ['pr', 'head-sha', 'file']) {
    if (!values[key]) throw new Error(`--${key} is required\n\n${USAGE}`);
  }
  return publish({
    gh,
    repo,
    prNumber: values.pr,
    headSha: values['head-sha'],
    file: values.file,
    workflow: values.workflow,
    ref: values.ref,
    releaseId: values['release-id'],
    maxBytes: values['max-bytes'] ? Number(values['max-bytes']) : DEFAULT_MAX_HTML_BYTES,
    wait: !values['no-wait'],
    timeoutSec: Number(values.timeout),
    log,
  }).then((result) => {
    if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      for (const [k, v] of Object.entries(result)) if (v !== null && v !== undefined) process.stdout.write(`${k}=${v}\n`);
    }
    if (result.status === 'published' || result.status === 'dispatched') return 0;
    if (result.status === 'skipped') return 2;
    if (result.status === 'timeout') return 3;
    return 1;
  });
}

Promise.resolve()
  .then(main)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
