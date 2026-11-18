/**
 * OCTO FOUNDRY server.
 *
 * - Dev mode (--dev): Vite in middleware mode, so one port serves the game and
 *   the API. Phone connects over the LAN.
 * - Prod mode: serves the built dist/ folder plus the same API.
 *
 * The MiniMax API key lives here (env MINIMAX_API_KEY or .env) and is never
 * sent to the browser. A key pasted into the in-game Settings is forwarded
 * per-request via the x-api-key header and is not stored on the server.
 */

import express from 'express';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT || (DEV ? 5173 : 3000));

dotenv.config({ path: path.join(ROOT, '.env') });

const API_BASE = process.env.MINIMAX_API_HOST || 'https://api.minimax.io';
const DEFAULT_MODEL = process.env.MINIMAX_MODEL || 'MiniMax-M3.1-Flash';

const app = express();
app.use(express.json({ limit: '256kb' }));

/* ------------------------------------------------------------------ */
/* Tower forge                                                        */
/* ------------------------------------------------------------------ */

const PRESET_FINGERPRINTS = [
  { name: 'Iron Cannon', damageType: 'kinetic', projectileShape: 'shell', color: '#ff8a3d' },
  { name: 'Tesla Coil', damageType: 'electric', projectileShape: 'bolt', color: '#59d8ff' },
  { name: 'Cryo Vent', damageType: 'thermal', projectileShape: 'shard', color: '#9ceaff' },
  { name: 'Spore Bloom', damageType: 'corrosive', projectileShape: 'spore', color: '#7dff6a' },
  { name: 'Flame Vent', damageType: 'thermal', projectileShape: 'plume', color: '#ff5a2a' },
  { name: 'Scatter Gun', damageType: 'kinetic', projectileShape: 'pellet', color: '#ffd23d' },
  { name: 'Rail Lance', damageType: 'kinetic', projectileShape: 'lance', color: '#ff4d6d' },
];

const ALLOWED_SHAPES = [
  'shell', 'bolt', 'shard', 'spore', 'plume', 'pellet', 'lance',
  'orb', 'disc', 'wave', 'mine', 'drone', 'coil', 'plasma', 'lattice',
  'vortex', 'crystal', 'pulse', 'fang', 'helix', 'prism', 'needle',
  'torrent', 'snare', 'ember', 'chainmail',
];

const ALLOWED_EFFECTS = [
  'splash', 'chain', 'chill', 'burn', 'pierce', 'homing', 'beam',
  'shred', 'stun', 'pull', 'emp', 'mark', 'ricochet', 'slam', 'volatile',
];

function stripThinking(text) {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

/** Close a truncated JSON object so a cut-off answer can still be used. */
function closeJson(text) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = text;
  if (inString) out += '"';
  // Drop a dangling separator or half-written key.
  out = out.replace(/[,\s]*$/, '');
  if (/[,{[]\s*"[^"]*$/.test(out)) {
    out = out.replace(/[,{[]\s*"[^"]*$/, '');
  }
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  return out;
}

function extractJson(text) {
  const clean = stripThinking(text);
  try {
    return JSON.parse(clean);
  } catch {
    /* fall through */
  }
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  if (start >= 0) {
    try {
      return JSON.parse(closeJson(clean.slice(start)));
    } catch {
      return null;
    }
  }
  return null;
}

function normaliseHexColor(value) {
  const m = String(value || '').match(/#?([0-9a-f]{6}|[0-9a-f]{3})/i);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return `#${hex.toLowerCase()}`;
}

function usedSets(used, presets) {
  const names = new Set();
  const types = new Set();
  const shapes = new Set();
  const colors = new Set();
  for (const p of presets) {
    names.add(p.name.toLowerCase());
    types.add(p.damageType.toLowerCase());
    shapes.add(p.projectileShape);
    colors.add(String(p.color).toLowerCase());
  }
  for (const u of used ?? []) {
    if (!u) continue;
    if (u.name) names.add(String(u.name).toLowerCase());
    if (u.damageType) types.add(String(u.damageType).toLowerCase());
    if (u.projectileShape) shapes.add(String(u.projectileShape));
    if (u.color) colors.add(String(u.color).toLowerCase());
  }
  return { names, types, shapes, colors };
}

function validateTower(tower, used) {
  const sets = usedSets(used, PRESET_FINGERPRINTS);
  const problems = [];
  if (!tower || typeof tower !== 'object') return { ok: false, problems: ['not an object'] };

  const name = String(tower.name || '').trim();
  if (!name) problems.push('missing name');
  else if (sets.names.has(name.toLowerCase())) problems.push(`name "${name}" already used`);

  const damageType = String(tower.damageType || '').trim().toLowerCase();
  if (!damageType) problems.push('missing damageType');
  else if (sets.types.has(damageType)) problems.push(`damageType "${damageType}" already used`);

  // The projectile silhouette may be invented - it only has to be new.
  const shape = String(tower.projectileShape || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!shape) problems.push('missing projectileShape');
  else if (sets.shapes.has(shape)) problems.push(`projectileShape "${shape}" already used`);

  const color = normaliseHexColor(tower.color);
  if (!color) problems.push('color must be a hex value like #a1b2c3');
  else if (sets.colors.has(color)) problems.push(`color "${color}" already used`);

  const damage = Number(tower.damage);
  if (!Number.isFinite(damage) || damage < 2 || damage > 260) problems.push('damage must be 2..260');
  const fireRate = Number(tower.fireRate);
  if (!Number.isFinite(fireRate) || fireRate < 0.25 || fireRate > 10) problems.push('fireRate must be 0.25..10');
  const range = Number(tower.range);
  if (!Number.isFinite(range) || range < 2.2 || range > 9) problems.push('range must be 2.2..9');

  return { ok: problems.length === 0, problems, color, shape };
}

function buildPrompt(used, retryNote, brief) {
  const sets = usedSets(used, PRESET_FINGERPRINTS);
  const usedNames = [...sets.names].join(', ');
  const usedTypes = [...sets.types].join(', ');
  const usedShapes = [...sets.shapes].join(', ');
  const usedColors = [...sets.colors].join(', ');

  const briefBlock = brief
    ? `
THE PLAYER HAS ASKED FOR THIS SPECIFIC THING:
"${brief}"

Build the tower around that request. Honour the player's idea as closely as you can - the
damage type, the behaviour and the impact should all serve what they asked for - while still
obeying every rule below (new name, new damage type, new silhouette, new colour, valid effect).
`
    : `
The player did not specify anything, so invent the most interesting device you can.
`;

  return `You design ONE brand new tower for an industrial tower-defense game called OCTO FOUNDRY.

You must invent something that has NEVER existed in this game before.
${briefBlock}
ALREADY IN THE GAME - you MUST NOT repeat any of these names, damage types, projectile styles or colours:
names: ${usedNames}
damage types: ${usedTypes}
projectile shapes: ${usedShapes}
colours: ${usedColors}

ALLOWED projectile silhouettes (you may use one of these, or invent a brand new short kebab-case name that is not already used): ${ALLOWED_SHAPES.join(', ')}
ALLOWED effects (pick exactly one, this field must be one of these): ${ALLOWED_EFFECTS.join(', ')}

Rules for the design:
- Give it a NEW kind of damage that does not exist yet (be imaginative: sonic, gravity, magnetic, psychic, arcane, corrosive, kinetic-vacuum, etc.)
- Give it a NEW projectile silhouette. You MAY invent a short kebab-case silhouette name (for example "coiling-orb", "razor-spindle", "singing-lattice") as long as it is not one of the used ones. Keep it under 20 characters, lowercase, letters and dashes only.
- Give it a NEW colour (hex) that is not already used.
- The impact effect and the sound must be described in ONE short vivid sentence each (under 120 characters), and must be specific to this tower. The mechanic must be under 160 characters. Keep the whole answer compact.
- The "effect" field MUST be exactly one of the allowed effects listed above.
- Balance it: it should feel worth roughly 140-520 gold.
${retryNote ? `\nIMPORTANT: your previous attempt was rejected because: ${retryNote}. Do something completely different - a different name, a different damage type, a different silhouette name and a different colour.` : ''}

Reply with ONLY a JSON object, no prose, no markdown:
{"name":"...","damageType":"...","effect":"...","damage":25,"fireRate":1.2,"range":4.5,"burst":1,"projectileShape":"vortex","color":"#7c4dff","impact":"...","sound":"...","mechanic":"..."}`;
}

async function callMiniMax(prompt, model, apiKey) {
  const res = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a game designer. You reply with a single valid JSON object and nothing else.' },
        { role: 'user', content: prompt },
      ],
      temperature: 1.0,
      max_tokens: 3000,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MiniMax ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const finishReason = data?.choices?.[0]?.finish_reason ?? '';
  if (!raw) {
    console.log('[forge] empty content, full response:', JSON.stringify(data).slice(0, 1200));
  }
  return { json: extractJson(raw), raw, finishReason };
}

app.post('/api/forge', async (req, res) => {
  const apiKey = req.get('x-api-key') || process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: 'No MiniMax API key on the server. Set MINIMAX_API_KEY in .env or paste one in Settings.',
    });
    return;
  }

  const model = req.body?.model || DEFAULT_MODEL;
  const used = Array.isArray(req.body?.used) ? req.body.used : [];
  const brief = String(req.body?.brief || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const attempts = Math.min(4, Math.max(1, Number(req.body?.attempts) || 3));

  let lastProblems = [];
  let lastRaw = '';
  for (let i = 0; i < attempts; i++) {
    const note = i === 0 ? '' : lastProblems.join('; ');
    const prompt = buildPrompt(used, note, brief);
    let tower;
    let raw = '';
    let finishReason = '';
    try {
      const res = await callMiniMax(prompt, model, apiKey);
      tower = res.json;
      raw = res.raw;
      finishReason = res.finishReason;
    } catch (err) {
      res.status(502).json({ error: `MiniMax call failed: ${err.message}` });
      return;
    }
    const check = validateTower(tower, used);
    if (check.ok) {
      const color = check.color;
      const effect = ALLOWED_EFFECTS.includes(tower.effect) ? tower.effect : 'none';
      res.json({
        tower: {
          name: String(tower.name).trim(),
          damageType: String(tower.damageType).trim().toLowerCase(),
          effect,
          damage: Number(tower.damage),
          fireRate: Number(tower.fireRate),
          range: Number(tower.range),
          burst: Math.min(6, Math.max(1, Math.round(Number(tower.burst) || 1))),
          projectileShape: check.shape,
          color,
          impact: String(tower.impact || '').slice(0, 200),
          sound: String(tower.sound || '').slice(0, 200),
          mechanic: String(tower.mechanic || '').slice(0, 260),
        },
        model,
        attempt: i + 1,
      });
      return;
    }
    lastProblems = check.problems;
    lastRaw = stripThinking(raw).slice(0, 400);
    console.log(`[forge] attempt ${i + 1} rejected (finish=${finishReason}): ${check.problems.join('; ')}`);
  }

  console.log(`[forge] rejected raw: ${lastRaw}`);
  res.status(422).json({ error: 'The model kept repeating itself.', problems: lastProblems, raw: lastRaw });
});

app.get('/api/health', async (_req, res) => {
  const keyPresent = !!process.env.MINIMAX_API_KEY;
  let models = [];
  if (keyPresent) {
    try {
      const r = await fetch(`${API_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}` },
      });
      if (r.ok) {
        const j = await r.json();
        models = (j?.data ?? []).map((m) => m.id);
      }
    } catch {
      models = [];
    }
  }
  res.json({ keyPresent, model: DEFAULT_MODEL, models, apiBase: API_BASE });
});

/* ------------------------------------------------------------------ */
/* Static + dev server                                                */
/* ------------------------------------------------------------------ */

if (DEV) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: ROOT,
    server: { middlewareMode: true, host: '0.0.0.0', port: PORT },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) {
    console.error('dist/ not found - run "npm run build" first.');
  }
  // Hashed assets are safe to cache hard; index.html must never be cached or
  // the browser keeps running an old bundle.
  app.use(express.static(dist, { maxAge: '1y', immutable: true, etag: true, index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    // Express 5 + send cannot resolve an absolute Windows path here, so the
    // file is addressed through `root`.
    res.sendFile('index.html', { root: dist });
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  OCTO FOUNDRY  ${DEV ? '[dev]' : '[build]'}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://0.0.0.0:${PORT}  (phone on the same LAN)`);
  console.log(`  MiniMax key: ${process.env.MINIMAX_API_KEY ? 'loaded' : 'MISSING (set MINIMAX_API_KEY in .env)'}`);
  console.log(`  Model: ${DEFAULT_MODEL}\n`);
});
