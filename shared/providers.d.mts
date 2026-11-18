export type ProviderCompat = 'openai' | 'anthropic';

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  compat: ProviderCompat;
  defaultModel: string;
  models: string[];
  envKey: string;
  docs: string;
  verified: boolean;
  longKey?: boolean;
}

export interface KnownEndpoint {
  name: string;
  aliases: string[];
  baseUrl: string;
  compat: ProviderCompat;
  model: string;
  docs: string;
  verified: boolean;
}

export const PROVIDERS: ProviderPreset[];
export const CUSTOM_PROVIDER_ID: 'custom';
export const MAX_API_KEY_LENGTH: number;
export const KNOWN_ENDPOINTS: KnownEndpoint[];
export function providerById(id: string): ProviderPreset | null;
export function normaliseServiceName(name: string): string;
export function lookupKnownEndpoint(name: string): KnownEndpoint | null;
export function cleanApiKey(raw: unknown): string;
export function validateApiKey(raw: unknown): { ok: boolean; key: string; problem: string };
