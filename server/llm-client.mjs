/**
 * Minimal, dependency-free chat client for OpenAI-compatible and
 * Anthropic-compatible endpoints, with per-call timeouts and retries with
 * exponential backoff + jitter (honouring Retry-After).
 */

import dns from 'node:dns/promises';
import net from 'node:net';

export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, kind?: 'auth'|'quota'|'rate'|'timeout'|'network'|'http'|'empty'|'config', retryable?: boolean, retryAfterMs?: number }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = info.status ?? 0;
    this.kind = info.kind ?? 'http';
    this.retryable = info.retryable ?? false;
    this.retryAfterMs = info.retryAfterMs ?? 0;
  }
}

const trimSlash = (s) => String(s ?? '').trim().replace(/\/+$/, '');

/** Full URL for a chat call given a base URL and a compatibility mode. */
export function chatUrl(baseUrl, compat) {
  const base = trimSlash(baseUrl);
  if (compat === 'anthropic') {
    if (/\/v1\/messages$/.test(base)) return base;
    if (/\/v1$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

/** Models-list URL used to probe an endpoint. */
export function modelsUrl(baseUrl, compat) {
  const base = trimSlash(baseUrl).replace(/\/chat\/completions$/, '').replace(/\/v1\/messages$/, '/v1').replace(/\/messages$/, '');
  if (compat === 'anthropic') return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
  return `${base}/models`;
}

function authHeaders(compat, apiKey) {
  if (compat === 'anthropic') {
    // Anthropic uses x-api-key; several Anthropic-compatible gateways
    // (MiniMax, Agnes) also accept a bearer token, so send both.
    return { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function classifyStatus(status, body) {
  const text = String(body ?? '').toLowerCase();
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 429) {
    const quota = /quota|insufficient|balance|usage limit|billing|credit/.test(text);
    return { kind: quota ? 'quota' : 'rate', retryable: !quota };
  }
  if (status === 408 || status === 409 || status === 425 || status >= 500) return { kind: 'http', retryable: true };
  return { kind: 'http', retryable: false };
}

/** Extract assistant text from either response shape. */
export function readCompletion(data, compat) {
  if (compat === 'anthropic') {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string') && b.type !== 'thinking')
      .map((b) => b.text ?? '')
      .join('');
    return { text, finishReason: String(data?.stop_reason ?? '') };
  }
  const choice = data?.choices?.[0] ?? {};
  let content = choice?.message?.content ?? choice?.text ?? '';
  if (Array.isArray(content)) content = content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  // Some reasoning models leave content empty and put everything in reasoning_content.
  if (!content && typeof choice?.message?.reasoning_content === 'string') content = choice.message.reasoning_content;
  return { text: String(content ?? ''), finishReason: String(choice?.finish_reason ?? '') };
}

/**
 * One chat call with a hard timeout. Throws LlmError.
 * @param {{ compat: 'openai'|'anthropic', baseUrl: string, apiKey: string, model: string, system: string, prompt: string, maxTokens?: number, temperature?: number, timeoutMs?: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} o
 */
export async function chatOnce(o) {
  const fetchImpl = o.fetchImpl ?? fetch;
  const url = chatUrl(o.baseUrl, o.compat);
  const timeoutMs = o.timeoutMs ?? 45000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  const onOuterAbort = () => ctrl.abort(o.signal?.reason);
  o.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const body =
    o.compat === 'anthropic'
      ? {
          model: o.model,
          system: o.system,
          messages: [{ role: 'user', content: o.prompt }],
          max_tokens: o.maxTokens ?? 3000,
          temperature: o.temperature ?? 1,
        }
      : {
          model: o.model,
          messages: [
            { role: 'system', content: o.system },
            { role: 'user', content: o.prompt },
          ],
          max_tokens: o.maxTokens ?? 3000,
          temperature: o.temperature ?? 1,
        };

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(o.compat, o.apiKey) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onOuterAbort);
    if (o.signal?.aborted) throw new LlmError('request cancelled', { kind: 'network', retryable: false });
    if (ctrl.signal.aborted) throw new LlmError(`timed out after ${timeoutMs} ms`, { kind: 'timeout', retryable: true });
    throw new LlmError(`network error: ${err?.message ?? err}`, { kind: 'network', retryable: true });
  }

  try {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const { kind, retryable } = classifyStatus(res.status, text);
      throw new LlmError(`HTTP ${res.status}: ${text.slice(0, 300)}`, {
        status: res.status,
        kind,
        retryable,
        retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')),
      });
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new LlmError('response was not JSON', { status: res.status, kind: 'http', retryable: true });
    }
    // Some gateways report errors with HTTP 200 (MiniMax base_resp, OpenAI-style error object).
    const baseResp = data?.base_resp;
    if (baseResp && Number(baseResp.status_code) && Number(baseResp.status_code) !== 0) {
      const code = Number(baseResp.status_code);
      const msg = String(baseResp.status_msg ?? '');
      const quota = code === 1008 || /quota|balance|limit/i.test(msg);
      throw new LlmError(`provider error ${code}: ${msg}`, { status: 200, kind: quota ? 'quota' : 'http', retryable: !quota && code >= 1000 && code < 1010 });
    }
    if (data?.error && !data?.choices && !data?.content) {
      const msg = typeof data.error === 'string' ? data.error : data.error?.message ?? JSON.stringify(data.error);
      throw new LlmError(`provider error: ${String(msg).slice(0, 300)}`, { status: 200, kind: 'http', retryable: false });
    }
    const out = readCompletion(data, o.compat);
    if (!out.text.trim()) throw new LlmError('empty completion', { kind: 'empty', retryable: true });
    return out;
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (ctrl.signal.aborted) throw new LlmError(`timed out after ${timeoutMs} ms`, { kind: 'timeout', retryable: true });
    throw new LlmError(String(err?.message ?? err), { kind: 'network', retryable: true });
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onOuterAbort);
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new LlmError('request cancelled', { kind: 'network' }));
      },
      { once: true },
    );
  });

/** Backoff delay for attempt n (0-based): base * 2^n with +-25% jitter, capped. */
export function backoffDelay(attempt, baseMs = 600, maxMs = 8000, rand = Math.random) {
  const raw = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(raw * (0.75 + rand() * 0.5));
}

/**
 * Retry `fn` on retryable LlmErrors. Non-retryable errors (bad key, quota,
 * 4xx) surface immediately so the player sees the real reason.
 */
export async function withRetry(fn, { retries = 2, baseMs = 600, maxMs = 8000, signal, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = err instanceof LlmError ? err.retryable : false;
      if (!retryable || attempt >= retries || signal?.aborted) throw err;
      const wait = Math.max(backoffDelay(attempt, baseMs, maxMs), Math.min(maxMs, err.retryAfterMs || 0));
      onRetry?.(err, attempt + 1, wait);
      await sleep(wait, signal);
      attempt++;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Outbound URL safety                                                 */
/* ------------------------------------------------------------------ */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIp(mapped[1]) : false;
}

/**
 * The custom provider form lets a player type any base URL, and the server
 * makes the request, so block LAN/loopback/metadata targets unless the owner
 * opts in with ALLOW_PRIVATE_PROVIDER_URLS=1 (e.g. for a local Ollama).
 */
export async function assertPublicUrl(raw, { allowPrivate = false, lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new LlmError('base URL is not a valid URL', { kind: 'config' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new LlmError('base URL must start with http:// or https://', { kind: 'config' });
  }
  if (url.username || url.password) throw new LlmError('base URL must not contain credentials', { kind: 'config' });
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new LlmError('private/local addresses are blocked (set ALLOW_PRIVATE_PROVIDER_URLS=1 to allow)', { kind: 'config' });
  }
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new LlmError(`cannot resolve ${host}`, { kind: 'network' });
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new LlmError('private/local addresses are blocked (set ALLOW_PRIVATE_PROVIDER_URLS=1 to allow)', { kind: 'config' });
  }
  return url;
}
