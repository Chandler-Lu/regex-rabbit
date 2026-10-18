import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const policySource = readFileSync(new URL('../../domain/runtime_policy.js', import.meta.url), 'utf8');

// Isolated module tests use the same mandatory policy dependency as page,
// background, offscreen and Worker entry points. Other fixture data stays raw.
function withPolicy(path, source) {
  return String(path).endsWith('.js') && !String(path).endsWith('/runtime_policy.js') ?
    `if (!globalThis.RRRuntimePolicy) {\n${policySource}\n}\n${source}` : source;
}

export async function readRuntimeSource(path, encoding) {
  return withPolicy(path, await readFile(path, encoding));
}

export function readRuntimeSourceSync(path, encoding) {
  return withPolicy(path, readFileSync(path, encoding));
}
