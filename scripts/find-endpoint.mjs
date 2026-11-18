#!/usr/bin/env node
/**
 * Find an AI provider's API endpoint from the command line - the same lookup
 * the in-game SEARCH button uses.
 *
 *   npm run find-endpoint -- "OpenAI"
 *   node scripts/find-endpoint.mjs "Some New Lab" --no-probe --json
 *
 * Prints the suggested base URL, whether it is OpenAI- or Anthropic-
 * compatible, how sure it is, and where it found it.
 */
import { findEndpoint } from '../server/endpoint-finder.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const name = args.filter((a) => !a.startsWith('--')).join(' ').trim();
if (!name) {
  console.error('usage: node scripts/find-endpoint.mjs "<AI service name>" [--no-probe] [--no-web] [--json]');
  process.exit(2);
}

const result = await findEndpoint(name, { probe: !flags.has('--no-probe'), web: !flags.has('--no-web') });
if (flags.has('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else if (!result.ok) {
  console.log(`Not found: ${result.error}`);
} else {
  console.log(`Service       : ${result.name}`);
  console.log(`Base URL      : ${result.baseUrl}`);
  console.log(`Compatibility : ${result.compat === 'anthropic' ? 'Anthropic-compatible (POST /v1/messages)' : 'OpenAI-compatible (POST /chat/completions)'}`);
  if (result.model) console.log(`Model hint    : ${result.model}`);
  console.log(`Confidence    : ${Math.round(result.confidence * 100)}% (${result.source === 'known' ? 'built-in table' : 'web search'}${result.verified ? ', verified' : ''})`);
  for (const s of result.sources ?? []) console.log(`Source        : ${s}`);
  for (const c of (result.candidates ?? []).slice(1, 4)) console.log(`Alternative   : ${c.baseUrl} (${c.compat})`);
  console.log(`\n${result.notes}`);
}
process.exit(result.ok ? 0 : 1);
