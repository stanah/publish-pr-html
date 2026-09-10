// Helpers for running inside GitHub Actions without @actions/core.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function getInput(name, { required = false } = {}) {
  const value = process.env[`INPUT_${name.toUpperCase()}`] ?? '';
  if (required && value.trim() === '') throw new Error(`input "${name}" is required`);
  return value;
}

export function getEnv(name, { required = true } = {}) {
  const value = process.env[name] ?? '';
  if (required && value === '') throw new Error(`environment variable ${name} is not set`);
  return value;
}

export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${markdown}\n`);
}

export function info(message) {
  console.log(message);
}

export function notice(message) {
  console.log(`::notice::${escapeData(message)}`);
}

export function warning(message) {
  console.log(`::warning::${escapeData(message)}`);
}

export function error(message) {
  console.log(`::error::${escapeData(message)}`);
}

export function runMain(fn) {
  fn().catch((err) => {
    error(err && err.message ? err.message : String(err));
    process.exitCode = 1;
  });
}

export function context() {
  return {
    repo: getEnv('GITHUB_REPOSITORY'),
    ref: getEnv('GITHUB_REF'),
    sha: getEnv('GITHUB_SHA'),
    runId: getEnv('GITHUB_RUN_ID'),
    runNumber: Number(getEnv('GITHUB_RUN_NUMBER')),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || '1'),
    serverUrl: process.env.GITHUB_SERVER_URL || 'https://github.com',
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    runnerTemp: getEnv('RUNNER_TEMP'),
  };
}
