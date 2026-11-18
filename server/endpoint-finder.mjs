/**
 * "SEARCH" button backend for the custom provider form.
 *
 * Given a service name ("OpenAI", "Groq", "Some New Lab") it returns a
 * suggested base URL and whether the endpoint speaks the OpenAI or the
 * Anthropic dialect:
 *
 *   1. Built-in table (shared/providers.mjs) for an instant answer.
 *   2. Web search (DuckDuckGo HTML endpoint - no API key needed), then the top
 *      result pages are fetched and scanned for API URLs.
 *   3. Heuristics turn URLs into base URLs (/chat/completions -> OpenAI,
 *      /v1/messages or /anthropic -> Anthropic) and score them.
 *   4. Optional probe: GET <base>/models without a key. A 200/401/403 JSON
 *      reply proves the endpoint exists; Anthropic-style error bodies
 *      ("authentication_error") flip the compatibility guess.
 *
 * The result is ALWAYS a suggestion - the form shows it for the player to
 * review and edit before saving.
 */

import { lookupKnownEndpoint, normaliseServiceName } from '../shared/providers.mjs';
import { assertPublicUrl, modelsUrl } from './llm-client.mjs';

const UA = 'Mozilla/5.0 (compatible; OctoFoundryEndpointFinder/1.0)';
const MAX_PAGE_BYTES = 700_000;

/** Hosts that mention API URLs but never host a provider's API. */
const NOISE_HOSTS = [
  'duckduckgo.com', 'google.com', 'bing.com', 'github.com', 'githubusercontent.com', 'gitlab.com',
  'stackoverflow.com', 'reddit.com', 'medium.com', 'youtube.com', 'twitter.com', 'x.com',
  'facebook.com', 'linkedin.com', 'wikipedia.org', 'w3.org', 'schema.org', 'npmjs.com', 'pypi.org',
  'fonts.googleapis.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cloudflare.com', 'gstatic.com',
  'example.com', 'localhost', 'json-schema.org', 'mintlify.com', 'mintlify.site', 'mintlify.app', 'readme.io', 'vercel.app', 'apis.io', 'puter.com',
];

const NON_LLM_PATH = /\b(gpu|instance|instances|image|images|video|videos|audio|speech|tts|storage|billing|admin|account|files|batch|fine[-_]?tun\w*|dashboard|webhook)\b/i;

const OPENAI_HINTS = /openai[- ]compatible|openai[- ]style|openai sdk|chat\/completions|openai_base_url|base_url=|baseurl:/gi;
const ANTHROPIC_HINTS = /anthropic[- ]compatible|anthropic sdk|\/v1\/messages|anthropic-version|anthropic_base_url|claude[- ]compatible/gi;

async function fetchText(url, { fetchImpl = fetch, timeoutMs = 7000, allowPrivate = false } = {}) {
  await assertPublicUrl(url, { allowPrivate });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const text = await res.text();
    return text.slice(0, MAX_PAGE_BYTES);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/gi, '/');

/** Visible-ish text from HTML, keeping code blocks (where API URLs live). */
export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, (m) => (/(https?:\/\/[^"'\s]+\/v\d)/.test(m) ? m.replace(/<[^>]+>/g, ' ') : ' '))
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t]+/g, ' ');
}

/** Parse DuckDuckGo's HTML results page into {url, title, snippet}. */
export function parseDuckDuckGo(html) {
  const text = String(html ?? '');
  const anchors = [];
  // html.duckduckgo.com uses class="result__a"; lite.duckduckgo.com uses class='result-link'.
  const re = /<a[^>]+class=["'][^"']*\b(?:result__a|result-link)\b[^"']*["'][^>]*>/gi;
  let m;
  while ((m = re.exec(text))) anchors.push({ index: m.index, tag: m[0], end: m.index + m[0].length });
  const out = [];
  for (let i = 0; i < anchors.length && out.length < 12; i++) {
    const a = anchors[i];
    const hrefMatch = a.tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    let href = decodeEntities(hrefMatch[1]);
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:\/\//.test(href)) continue;
    // Title runs to the closing </a>; the snippet sits before the next result.
    const segment = text.slice(a.end, anchors[i + 1]?.index ?? text.length);
    const close = segment.indexOf('</a>');
    const title = close >= 0 ? segment.slice(0, close) : '';
    const snip = segment.match(/class=["'][^"']*\bresult[-_]{1,2}snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|td)>/i);
    out.push({
      url: href,
      title: decodeEntities(title.replace(/<[^>]+>/g, '')).trim(),
      snippet: decodeEntities(String(snip?.[1] ?? '').replace(/<[^>]+>/g, '')).trim(),
    });
  }
  return out;
}

function hostIsNoise(host) {
  return NOISE_HOSTS.some((n) => host === n || host.endsWith(`.${n}`));
}

/** Turn one raw URL into {baseUrl, compat|null}, or null if it is not API-shaped. */
export function deriveBase(raw) {
  let url;
  try {
    url = new URL(raw.replace(/[.,;:)\]}>'"`]+$/, ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (hostIsNoise(host)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  const origin = `${url.protocol}//${url.host}`;

  let m = path.match(/^(.*?)\/chat\/completions\b/);
  if (m) return { baseUrl: origin + m[1], compat: 'openai', host, strong: true };
  m = path.match(/^(.*?)\/v1\/messages\b/);
  if (m) return { baseUrl: origin + m[1], compat: 'anthropic', host, strong: true };
  m = path.match(/^(.*?\/anthropic)(?:\/|$)/);
  if (m) return { baseUrl: origin + m[1], compat: 'anthropic', host, strong: true };
  m = path.match(/^(.*?\/openai(?:\/v\d+(?:beta\d*)?)?)(?:\/|$)/);
  if (m) return { baseUrl: origin + m[1], compat: 'openai', host, strong: false };
  m = path.match(/^(.*?\/v\d+(?:beta\d*|alpha\d*)?)(?:\/|$)/);
  if (m && (host.startsWith('api.') || host.includes('api') || /\/(api|inference)\//.test(path + '/'))) {
    return { baseUrl: origin + m[1], compat: null, host, strong: false };
  }
  if ((path === '' || path === '/') && host.startsWith('api.')) return { baseUrl: origin, compat: null, host, strong: false };
  return null;
}

function countHints(text, re) {
  return (String(text).match(re) ?? []).length;
}

/**
 * Score every API-looking URL in `docs` (array of {url, text}).
 * Pure function - unit tested with fixture pages.
 */
export function rankCandidates(name, docs) {
  const key = normaliseServiceName(name);
  const tokens = String(name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !['api', 'the', 'inc', 'labs', 'cloud'].includes(t));
  const byBase = new Map();
  for (const doc of docs) {
    const text = doc.text ?? '';
    const re = /https?:\/\/[^\s"'<>()\\,`]+/g;
    let m;
    while ((m = re.exec(text))) {
      const d = deriveBase(m[0]);
      if (!d) continue;
      const ctx = text.slice(Math.max(0, m.index - 260), m.index + m[0].length + 260);
      let score = 1;
      if (d.strong) score += 3;
      if (d.host.startsWith('api.') || d.host.startsWith('apihub.') || d.host.startsWith('inference.') || d.host.startsWith('integrate.')) score += 2;
      const compactHost = d.host.replace(/[^a-z0-9]/g, '');
      if (key && compactHost.includes(key)) score += 3;
      else if (tokens.some((t) => compactHost.includes(t))) score += 2;
      else score -= 2;
      if (/base[_ ]?url|baseurl|endpoint|base address/i.test(ctx)) score += 2;
      if (/^(docs|www|platform|console|help|blog|status)\./.test(d.host) && !d.strong) score -= 2;
      // Dialect-named paths are almost always the LLM gateway.
      if (/\/(openai|anthropic)(\/|$)/.test(d.baseUrl)) score += 2;
      // Other product APIs on the same host (GPUs, images, billing...) are not what we want.
      if (NON_LLM_PATH.test(new URL(d.baseUrl).pathname)) score -= 4;
      const oa = countHints(ctx, OPENAI_HINTS);
      const an = countHints(ctx, ANTHROPIC_HINTS);
      const prev = byBase.get(d.baseUrl) ?? { baseUrl: d.baseUrl, compat: d.compat, score: 0, hits: 0, openai: 0, anthropic: 0, sources: new Set() };
      prev.score += score;
      prev.hits += 1;
      prev.openai += oa + (d.compat === 'openai' ? 2 : 0);
      prev.anthropic += an + (d.compat === 'anthropic' ? 2 : 0);
      if (!prev.compat && d.compat) prev.compat = d.compat;
      prev.sources.add(doc.url);
      byBase.set(d.baseUrl, prev);
    }
  }
  const all = [...byBase.values()].map((c) => {
    const compat = c.compat ?? (c.anthropic > c.openai ? 'anthropic' : 'openai');
    // Repeated mentions matter, with diminishing returns.
    const score = c.score / Math.sqrt(c.hits) + Math.log2(1 + c.hits);
    return { baseUrl: c.baseUrl, compat, score: Math.round(score * 100) / 100, hits: c.hits, sources: [...c.sources].slice(0, 4), compatEvidence: { openai: c.openai, anthropic: c.anthropic } };
  });
  return all.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
}

/**
 * Probe <base>/models without a key. Never sends credentials.
 * @returns {Promise<{ reachable: boolean, status: number, compatHint: 'openai'|'anthropic'|null, models: string[] }>}
 */
export async function probeEndpoint(baseUrl, compat, { fetchImpl = fetch, timeoutMs = 5000, allowPrivate = false } = {}) {
  const url = modelsUrl(baseUrl, compat);
  try {
    await assertPublicUrl(url, { allowPrivate });
  } catch {
    return { reachable: false, status: 0, compatHint: null, models: [] };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'anthropic-version': '2023-06-01' },
      signal: ctrl.signal,
    });
    const body = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {
      /* not json */
    }
    let compatHint = null;
    if (/authentication_error|x-api-key header|anthropic-version/i.test(body)) compatHint = 'anthropic';
    else if (json && (Array.isArray(json.data) || json.error?.code === 'invalid_api_key' || /Incorrect API key|Bearer/i.test(body))) compatHint = 'openai';
    const models = Array.isArray(json?.data) ? json.data.map((m) => String(m?.id ?? '')).filter(Boolean).slice(0, 50) : [];
    const reachable = !!json && [200, 401, 403].includes(res.status);
    return { reachable, status: res.status, compatHint, models };
  } catch {
    return { reachable: false, status: 0, compatHint: null, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full lookup. Returns a suggestion object; never throws for "not found".
 * @param {string} name
 * @param {{ fetchImpl?: typeof fetch, web?: boolean, probe?: boolean, allowPrivate?: boolean, maxPages?: number }} [opts]
 */
export async function findEndpoint(name, opts = {}) {
  const query = String(name ?? '').trim().slice(0, 80);
  if (!query) return { ok: false, error: 'Type the name of the AI service to search for.' };
  const { fetchImpl = fetch, web = true, probe = true, allowPrivate = false, maxPages = 4 } = opts;

  const known = lookupKnownEndpoint(query);
  if (known) {
    return {
      ok: true,
      query,
      source: 'known',
      name: known.name,
      baseUrl: known.baseUrl,
      compat: known.compat,
      model: known.model,
      verified: known.verified,
      confidence: known.verified ? 0.95 : 0.8,
      sources: [known.docs],
      candidates: [],
      notes: known.verified
        ? 'From the built-in table (checked against the official docs).'
        : 'From the built-in table (common public value - double-check the docs).',
    };
  }
  if (!web) return { ok: false, query, error: `"${query}" is not in the built-in table and web search is off.` };

  const searches = [
    `${query} API base URL OpenAI compatible chat completions`,
    `${query} API endpoint documentation`,
  ];
  const results = [];
  const seen = new Set();
  for (const q of searches) {
    // The HTML endpoint sometimes rate-limits; the lite endpoint is a second chance.
    let found = parseDuckDuckGo(await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { fetchImpl }));
    if (!found.length) found = parseDuckDuckGo(await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, { fetchImpl }));
    for (const r of found) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      results.push(r);
    }
    if (results.length >= 8) break;
  }
  if (!results.length) {
    return { ok: false, query, error: 'Web search returned nothing (offline or blocked). Fill the form by hand.' };
  }

  const docs = [{ url: 'search-snippets', text: results.map((r) => `${r.title}\n${r.snippet}\n${r.url}`).join('\n\n') }];
  // Prefer pages on the service's own domain(s), then everything else.
  const key = normaliseServiceName(query);
  const ordered = [...results].sort((a, b) => Number(new URL(b.url).hostname.replace(/[^a-z0-9]/g, '').includes(key)) - Number(new URL(a.url).hostname.replace(/[^a-z0-9]/g, '').includes(key)));
  const pages = await Promise.all(
    ordered
      .filter((r) => !hostIsNoise(new URL(r.url).hostname))
      .slice(0, maxPages)
      .map(async (r) => ({ url: r.url, text: htmlToText(await fetchText(r.url, { fetchImpl, allowPrivate: false })) })),
  );
  docs.push(...pages.filter((p) => p.text));

  const candidates = rankCandidates(query, docs).slice(0, 6);
  if (!candidates.length) {
    return { ok: false, query, error: 'No API base URL found in the search results. Fill the form by hand.', sources: results.slice(0, 5).map((r) => r.url) };
  }

  if (probe) {
    await Promise.all(
      candidates.slice(0, 3).map(async (c) => {
        c.probe = await probeEndpoint(c.baseUrl, c.compat, { fetchImpl, allowPrivate });
        // Scale probe evidence to the candidate scores so it can break ties.
        const unit = Math.max(3, candidates[0].score * 0.15);
        if (c.probe.reachable) c.score += unit;
        if (c.probe.models.length) c.score += unit;
        else if (c.probe.status === 404) c.score -= 1;
        if (c.probe.compatHint) c.compat = c.probe.compatHint;
      }),
    );
    candidates.sort((a, b) => b.score - a.score);
  }

  const best = candidates[0];
  const second = Math.max(0, candidates[1]?.score ?? 0);
  // How clearly the winner beats the runner-up, plus probe evidence.
  const rel = best.score > 0 ? (best.score - second) / best.score : 0;
  const confidence = Math.max(0.15, Math.min(0.9, 0.3 + 0.4 * rel + (best.probe?.reachable ? 0.15 : 0) + (best.probe?.models?.length ? 0.1 : 0)));
  return {
    ok: true,
    query,
    source: 'web',
    name: query,
    baseUrl: best.baseUrl,
    compat: best.compat,
    model: best.probe?.models?.[0] ?? '',
    verified: false,
    confidence: Math.round(confidence * 100) / 100,
    sources: best.sources.filter((s) => s !== 'search-snippets'),
    candidates,
    notes: best.probe?.reachable
      ? `Endpoint answered GET /models (HTTP ${best.probe.status}). Check the model name before saving.`
      : 'Found by web search - review the URL and compatibility before saving.',
  };
}
