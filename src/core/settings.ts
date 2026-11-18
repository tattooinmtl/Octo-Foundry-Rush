/**
 * Player settings: audio, quality and the AI provider used by the forge.
 * Pure module (no DOM) so migration can be unit-tested.
 *
 * API keys pasted in Settings are kept in this browser's localStorage only
 * (one per provider) and sent to the game server per request.
 */

import {
  CUSTOM_PROVIDER_ID,
  PROVIDERS,
  cleanApiKey,
  providerById,
  validateApiKey,
  type ProviderCompat,
} from '../../shared/providers.mjs';

export interface CustomProviderSettings {
  name: string;
  baseUrl: string;
  compat: ProviderCompat;
  model: string;
}

export interface Settings {
  master: number;
  sfx: number;
  muted: boolean;
  quality: 'low' | 'medium' | 'high';
  /** Provider id: a preset id from shared/providers.mjs or 'custom'. */
  provider: string;
  /** Chosen model per provider id. */
  models: Record<string, string>;
  /** Optional per-provider API key (blank = use the server's key). */
  apiKeys: Record<string, string>;
  custom: CustomProviderSettings;
}

export const SETTINGS_VERSION = 2;

export function defaultSettings(): Settings {
  return {
    master: 0.8,
    sfx: 0.9,
    muted: false,
    quality: 'high',
    provider: 'minimax',
    models: Object.fromEntries(PROVIDERS.map((p) => [p.id, p.defaultModel])),
    apiKeys: {},
    custom: { name: '', baseUrl: '', compat: 'openai', model: '' },
  };
}

const num01 = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Accept anything that was ever stored (v1 had a single `model` + `apiKey`
 * that always meant MiniMax) and return clean v2 settings.
 */
export function migrateSettings(raw: unknown): Settings {
  const out = defaultSettings();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, any>;
  out.master = num01(r.master, out.master);
  out.sfx = num01(r.sfx, out.sfx);
  out.muted = r.muted === true;
  if (r.quality === 'low' || r.quality === 'medium' || r.quality === 'high') out.quality = r.quality;

  // v1 -> v2: the lone model/key belonged to MiniMax.
  if (typeof r.model === 'string' && r.model) out.models.minimax = str(r.model, 160);
  if (typeof r.apiKey === 'string' && r.apiKey) out.apiKeys.minimax = cleanApiKey(r.apiKey);

  if (typeof r.provider === 'string' && (r.provider === CUSTOM_PROVIDER_ID || providerById(r.provider))) {
    out.provider = r.provider;
  }
  if (r.models && typeof r.models === 'object') {
    for (const [k, v] of Object.entries(r.models)) if (typeof v === 'string' && v.trim()) out.models[k] = str(v, 160).trim();
  }
  if (r.apiKeys && typeof r.apiKeys === 'object') {
    for (const [k, v] of Object.entries(r.apiKeys)) {
      const check = validateApiKey(v);
      if (check.ok && check.key) out.apiKeys[k] = check.key;
    }
  }
  if (r.custom && typeof r.custom === 'object') {
    out.custom = {
      name: str(r.custom.name, 60),
      baseUrl: str(r.custom.baseUrl, 300).trim(),
      compat: r.custom.compat === 'anthropic' ? 'anthropic' : 'openai',
      model: str(r.custom.model, 160).trim(),
    };
  }
  return out;
}

/** Model to send for the active provider. */
export function activeModel(s: Settings): string {
  if (s.provider === CUSTOM_PROVIDER_ID) return s.custom.model;
  return s.models[s.provider] || providerById(s.provider)?.defaultModel || '';
}

/** Key to send for the active provider ('' = let the server use its own). */
export function activeApiKey(s: Settings): string {
  return s.apiKeys[s.provider] ?? '';
}

/** Short upper-case name for HUD/toasts ("MINIMAX", "NVIDIA", "MY LAB"). */
export function providerShortName(s: Settings): string {
  if (s.provider === CUSTOM_PROVIDER_ID) return (s.custom.name || 'CUSTOM').toUpperCase().slice(0, 18);
  const p = providerById(s.provider);
  return (p?.label.replace(/\s*\(.*\)$/, '').split(' ')[0] ?? s.provider).toUpperCase();
}
