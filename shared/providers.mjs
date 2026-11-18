/**
 * AI provider registry - shared by the Node server and the browser bundle.
 *
 * Pure data, no secrets. API keys are NEVER stored here: the server reads them
 * from the environment (see `envKey`) and the player can paste one in Settings,
 * which is sent per request in the `x-api-key` header.
 *
 * `verified` means the base URL and compatibility were checked against the
 * provider's official docs when this table was written (2026-11-18). Entries
 * with `verified: false` come from widely used public values and should be
 * double-checked before relying on them.
 *
 * compat:
 *   'openai'    -> POST {baseUrl}/chat/completions, Authorization: Bearer <key>
 *   'anthropic' -> POST {baseUrl}/v1/messages,       x-api-key: <key>
 */

/** @type {import("./providers.mjs").ProviderPreset[]} */
export const PROVIDERS = [
  {
    id: 'minimax',
    label: 'MiniMax (minimax.io)',
    baseUrl: 'https://api.minimax.io/v1',
    compat: 'openai',
    defaultModel: 'MiniMax-M3.1-Flash',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    envKey: 'MINIMAX_API_KEY',
    docs: 'https://platform.minimax.io/docs/guides/text-generation',
    // Docs: OpenAI-compatible https://api.minimax.io/v1, Anthropic-compatible https://api.minimax.io/anthropic
    verified: true,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM (build.nvidia.com)',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    compat: 'openai',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    models: [
      'meta/llama-3.3-70b-instruct',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      'nvidia/nemotron-3-super-120b-a12b',
      'deepseek-ai/deepseek-v4-flash',
      'minimaxai/minimax-m2.7',
      'moonshotai/kimi-k2-instruct',
    ],
    envKey: 'NVIDIA_API_KEY',
    docs: 'https://docs.api.nvidia.com/nim/reference/llm-apis',
    verified: true,
  },
  {
    id: 'reflection',
    label: 'Reflection AI (reflection.ai)',
    baseUrl: 'https://api.reflection.ai/openai/v1',
    compat: 'openai',
    defaultModel: 'Beam-1.0-501B-A23B',
    models: ['Beam-1.0-501B-A23B'],
    envKey: 'REFLECTION_API_KEY',
    docs: 'https://developers.reflection.ai/openai-compatibility',
    // Reflection keys are very long (~3x a normal key). Nothing in the game
    // truncates keys; MAX_API_KEY_LENGTH below leaves plenty of headroom.
    longKey: true,
    verified: true,
  },
  {
    id: 'agnes',
    label: 'Agnes AI (agnes-ai.com)',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    compat: 'openai',
    defaultModel: 'agnes-2.5-flash',
    models: ['agnes-2.5-flash', 'agnes-3.0-flash', 'agnes-2.0-flash', 'agnes-1.5-flash'],
    envKey: 'AGNES_API_KEY',
    docs: 'https://agnes-ai.com/en/docs/quickstart',
    // Also exposes an Anthropic-compatible POST /v1/messages on the same host.
    verified: true,
  },
];

/** Id used for the player's own provider (filled in through the custom form). */
export const CUSTOM_PROVIDER_ID = 'custom';

/** Generous ceiling: long keys (Reflection is ~3x normal) must never be cut. */
export const MAX_API_KEY_LENGTH = 8192;

/**
 * Well-known services for the custom-provider SEARCH button. Instant answers
 * before any web search runs. Only the PROVIDERS above were re-verified
 * against official docs; the rest are commonly published values.
 * @type {import("./providers.mjs").KnownEndpoint[]}
 */
export const KNOWN_ENDPOINTS = [
  ...PROVIDERS.map((p) => ({
    name: p.label.replace(/\s*\(.*\)$/, ''),
    aliases: [p.id],
    baseUrl: p.baseUrl,
    compat: p.compat,
    model: p.defaultModel,
    docs: p.docs,
    verified: p.verified,
  })),
  { name: 'MiniMax (Anthropic-compatible)', aliases: ['minimax anthropic'], baseUrl: 'https://api.minimax.io/anthropic', compat: 'anthropic', model: 'MiniMax-M3.1-Flash', docs: 'https://platform.minimax.io/docs/api-reference/text-anthropic-api', verified: true },
  { name: 'Agnes AI (Anthropic-compatible)', aliases: ['agnes anthropic'], baseUrl: 'https://apihub.agnes-ai.com', compat: 'anthropic', model: 'agnes-3.0-flash', docs: 'https://agnes-ai.com/en/docs/agnes-30-flash', verified: true },
  { name: 'OpenAI', aliases: ['openai', 'open ai', 'chatgpt', 'gpt'], baseUrl: 'https://api.openai.com/v1', compat: 'openai', model: '', docs: 'https://platform.openai.com/docs/api-reference', verified: false },
  { name: 'Anthropic', aliases: ['anthropic', 'claude'], baseUrl: 'https://api.anthropic.com', compat: 'anthropic', model: '', docs: 'https://docs.anthropic.com/en/api/messages', verified: false },
  { name: 'xAI', aliases: ['xai', 'x.ai', 'grok'], baseUrl: 'https://api.x.ai/v1', compat: 'openai', model: '', docs: 'https://docs.x.ai/', verified: false },
  { name: 'Google Gemini (OpenAI-compatible)', aliases: ['gemini', 'google', 'google ai'], baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', compat: 'openai', model: '', docs: 'https://ai.google.dev/gemini-api/docs/openai', verified: false },
  { name: 'Groq', aliases: ['groq'], baseUrl: 'https://api.groq.com/openai/v1', compat: 'openai', model: '', docs: 'https://console.groq.com/docs/openai', verified: false },
  { name: 'Mistral', aliases: ['mistral', 'mistral ai'], baseUrl: 'https://api.mistral.ai/v1', compat: 'openai', model: '', docs: 'https://docs.mistral.ai/api/', verified: false },
  { name: 'DeepSeek', aliases: ['deepseek'], baseUrl: 'https://api.deepseek.com/v1', compat: 'openai', model: '', docs: 'https://api-docs.deepseek.com/', verified: false },
  { name: 'Together AI', aliases: ['together', 'together ai', 'togetherai'], baseUrl: 'https://api.together.xyz/v1', compat: 'openai', model: '', docs: 'https://docs.together.ai/', verified: false },
  { name: 'OpenRouter', aliases: ['openrouter', 'open router'], baseUrl: 'https://openrouter.ai/api/v1', compat: 'openai', model: '', docs: 'https://openrouter.ai/docs', verified: false },
  { name: 'Fireworks AI', aliases: ['fireworks', 'fireworks ai'], baseUrl: 'https://api.fireworks.ai/inference/v1', compat: 'openai', model: '', docs: 'https://docs.fireworks.ai/', verified: false },
  { name: 'Cerebras', aliases: ['cerebras'], baseUrl: 'https://api.cerebras.ai/v1', compat: 'openai', model: '', docs: 'https://inference-docs.cerebras.ai/', verified: false },
  { name: 'Perplexity', aliases: ['perplexity', 'pplx'], baseUrl: 'https://api.perplexity.ai', compat: 'openai', model: '', docs: 'https://docs.perplexity.ai/', verified: false },
  { name: 'Ollama (local)', aliases: ['ollama'], baseUrl: 'http://localhost:11434/v1', compat: 'openai', model: '', docs: 'https://ollama.com/blog/openai-compatibility', verified: false },
];

/** Find a provider preset by id. */
export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Normalise a service name for table lookups ("Open AI" -> "openai"). */
export function normaliseServiceName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/https?:\/\//, '')
    .replace(/\.(com|ai|io|xyz|org|net|dev)\b.*$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** Instant lookup in KNOWN_ENDPOINTS. Returns null when nothing matches. */
export function lookupKnownEndpoint(name) {
  const key = normaliseServiceName(name);
  if (!key) return null;
  for (const k of KNOWN_ENDPOINTS) {
    const keys = [k.name, ...k.aliases].map(normaliseServiceName);
    if (keys.includes(key)) return k;
  }
  // Prefix match ("nvidia nim" -> nvidia, "reflection ai" -> reflection).
  for (const k of KNOWN_ENDPOINTS) {
    const keys = [k.name, ...k.aliases].map(normaliseServiceName).filter((s) => s.length >= 3);
    if (keys.some((s) => key.startsWith(s) || s.startsWith(key))) return k;
  }
  return null;
}

/** Strip every whitespace character a paste or a textarea may have added. */
export function cleanApiKey(raw) {
  return String(raw ?? '').replace(/\s+/g, '');
}

/** Validate a pasted key. Long keys are fine; only empty/oversized/odd ones fail. */
export function validateApiKey(raw) {
  const key = cleanApiKey(raw);
  if (!key) return { ok: true, key: '', problem: '' };
  if (key.length > MAX_API_KEY_LENGTH) return { ok: false, key, problem: `key is longer than ${MAX_API_KEY_LENGTH} characters` };
  // HTTP header values must be visible ASCII.
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, key, problem: 'key contains characters that cannot be sent in a header' };
  return { ok: true, key, problem: '' };
}
