/**
 * Settings migration + API key handling (long keys must survive intact).
 * Run: node --import ./scripts/register-ts.mjs scripts/settings-test.ts
 */
import assert from 'node:assert/strict';
import { migrateSettings, defaultSettings, activeModel, activeApiKey } from '../src/core/settings.ts';
import { validateApiKey, cleanApiKey, lookupKnownEndpoint, PROVIDERS, MAX_API_KEY_LENGTH } from '../shared/providers.mjs';
import { generatePath } from '../src/core/path.ts';

// v1 settings: one model + key, always MiniMax.
const v1 = { master: 0.5, sfx: 0.4, muted: true, quality: 'low', model: 'MiniMax-M3', apiKey: '  sk-abc\n' };
const s = migrateSettings(v1);
assert.equal(s.provider, 'minimax');
assert.equal(s.models.minimax, 'MiniMax-M3');
assert.equal(s.apiKeys.minimax, 'sk-abc');
assert.equal(s.quality, 'low');
assert.equal(s.muted, true);

// Garbage in, defaults out.
assert.deepEqual(migrateSettings('nonsense'), defaultSettings());
assert.equal(migrateSettings({ provider: 'evil', master: 'loud' }).provider, 'minimax');
assert.equal(migrateSettings({ master: 7 }).master, 1);

// Long keys: a Reflection-style key ~3x a normal one (and far beyond) is kept whole.
const normal = 'sk-' + 'a'.repeat(48);
const reflection = 'rfl_' + 'Zq9'.repeat(110); // ~334 chars
const huge = 'k'.repeat(4000);
for (const k of [normal, reflection, huge]) {
  const v = validateApiKey(k);
  assert.ok(v.ok, `key of ${k.length} chars accepted`);
  assert.equal(v.key.length, k.length, 'not truncated');
}
// Pasting into the textarea may wrap/insert newlines - they are removed, nothing else.
const wrapped = reflection.match(/.{1,60}/g)!.join('\n') + '\n';
assert.equal(cleanApiKey(wrapped), reflection);
assert.equal(validateApiKey('x'.repeat(MAX_API_KEY_LENGTH + 1)).ok, false);
assert.equal(validateApiKey('sk-é').ok, false, 'non-ASCII cannot go in a header');

const stored = migrateSettings({ provider: 'reflection', apiKeys: { reflection: reflection }, models: { reflection: 'Beam-1.0-501B-A23B' } });
assert.equal(activeApiKey(stored), reflection);
assert.equal(activeModel(stored), 'Beam-1.0-501B-A23B');

// Custom provider.
const c = migrateSettings({ provider: 'custom', custom: { name: 'Lab', baseUrl: 'https://api.lab.ai/v1', compat: 'anthropic', model: 'lab-1' } });
assert.equal(activeModel(c), 'lab-1');
assert.equal(c.custom.compat, 'anthropic');

// Registry sanity.
for (const id of ['minimax', 'nvidia', 'reflection', 'agnes']) assert.ok(PROVIDERS.some((p) => p.id === id), id);
assert.equal(PROVIDERS.find((p) => p.id === 'nvidia')!.baseUrl, 'https://integrate.api.nvidia.com/v1');
assert.equal(lookupKnownEndpoint('Open AI')?.baseUrl, 'https://api.openai.com/v1');
assert.equal(lookupKnownEndpoint('claude')?.compat, 'anthropic');
assert.equal(lookupKnownEndpoint('reflection.ai')?.baseUrl, 'https://api.reflection.ai/openai/v1');
assert.equal(lookupKnownEndpoint('agnes-ai')?.baseUrl, 'https://apihub.agnes-ai.com/v1');
assert.equal(lookupKnownEndpoint('zzzz-unknown'), null);

// The save format relies on a road being reproducible from its seed.
assert.equal(generatePath(31337).seed >>> 0, 31337);

console.log('settings + provider registry: all checks passed');
