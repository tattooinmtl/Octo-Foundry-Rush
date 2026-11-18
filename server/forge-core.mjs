/**
 * Pure tower-forge logic: prompt building, JSON recovery, validation and
 * repair. No network, no Express - so it can be unit-tested offline
 * (scripts/server-test.mjs).
 */

export const PRESET_FINGERPRINTS = [
  { name: 'Iron Cannon', damageType: 'kinetic', projectileShape: 'shell', color: '#ff8a3d' },
  { name: 'Tesla Coil', damageType: 'electric', projectileShape: 'bolt', color: '#59d8ff' },
  { name: 'Cryo Vent', damageType: 'thermal', projectileShape: 'shard', color: '#9ceaff' },
  { name: 'Spore Bloom', damageType: 'corrosive', projectileShape: 'spore', color: '#7dff6a' },
  { name: 'Flame Vent', damageType: 'thermal', projectileShape: 'plume', color: '#ff5a2a' },
  { name: 'Scatter Gun', damageType: 'kinetic', projectileShape: 'pellet', color: '#ffd23d' },
  { name: 'Rail Lance', damageType: 'kinetic', projectileShape: 'lance', color: '#ff4d6d' },
];

export const ALLOWED_SHAPES = [
  'shell', 'bolt', 'shard', 'spore', 'plume', 'pellet', 'lance',
  'orb', 'disc', 'wave', 'mine', 'drone', 'coil', 'plasma', 'lattice',
  'vortex', 'crystal', 'pulse', 'fang', 'helix', 'prism', 'needle',
  'torrent', 'snare', 'ember', 'chainmail',
];

export const ALLOWED_EFFECTS = [
  'splash', 'chain', 'chill', 'burn', 'pierce', 'homing', 'beam',
  'shred', 'stun', 'pull', 'emp', 'mark', 'ricochet', 'slam', 'volatile',
];

/** Gameplay ranges. Out-of-range numbers are clamped, never a reason to re-ask. */
export const LIMITS = {
  damage: [2, 260],
  fireRate: [0.25, 10],
  range: [2.2, 9],
  burst: [1, 6],
};

const MAX_USED = 200;
const MAX_BRIEF = 240;

/* ------------------------------------------------------------------ */
/* Input sanitising                                                    */
/* ------------------------------------------------------------------ */

/** Clean the player's brief: one line, no quotes/backticks that could break the prompt. */
export function sanitiseBrief(raw) {
  return String(raw ?? '')
    .replace(/[`"\u201c\u201d]/g, "'")
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BRIEF);
}

/** Only keep well-formed fingerprints from the client, capped in size. */
export function sanitiseUsed(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const u of raw.slice(0, MAX_USED)) {
    if (!u || typeof u !== 'object') continue;
    out.push({
      name: String(u.name ?? '').slice(0, 60),
      damageType: String(u.damageType ?? '').slice(0, 40),
      projectileShape: String(u.projectileShape ?? '').slice(0, 30),
      color: String(u.color ?? '').slice(0, 9),
    });
  }
  return out;
}

/** Model ids are short tokens like "MiniMax-M3.1-Flash" or "meta/llama-3.3-70b-instruct". */
export function sanitiseModel(raw, fallback) {
  const m = String(raw ?? '').trim();
  if (!m || m.length > 160 || !/^[\w.\-/:@+]+$/.test(m)) return fallback;
  return m;
}

/* ------------------------------------------------------------------ */
/* JSON recovery                                                       */
/* ------------------------------------------------------------------ */

/** Drop reasoning blocks and markdown fences a model may wrap the answer in. */
export function stripThinking(text) {
  if (!text) return '';
  let out = String(text)
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .trim();
  // A reasoning block that never closed: drop the tag and let extractJson()
  // pick the tower-shaped object out of the remaining prose.
  out = out.replace(/^<think(?:ing)?>/i, '');
  // Fences anywhere (```json ... ```), not only at the very start/end.
  out = out.replace(/```(?:json|javascript|js)?\s*/gi, '').replace(/```/g, '');
  return out.trim();
}

/** Close a truncated JSON object so a cut-off answer can still be used. */
export function closeJson(text) {
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
  out = out.replace(/[,\s]*$/, '');
  // Drop a dangling key with no value ("..., "range") or a key with a colon but no value.
  out = out.replace(/,\s*"[^"]*"\s*:?\s*$/, '');
  out = out.replace(/\{\s*"[^"]*"\s*:?\s*$/, '{');
  out = out.replace(/:\s*$/, ': null');
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  return out;
}

/** Light syntax repair for common model slips (trailing commas, smart quotes). */
function looseRepair(text) {
  return text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

function tryParse(text) {
  for (const candidate of [text, looseRepair(text)]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Every balanced top-level {...} slice in the text, in order. */
function balancedObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
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
    if (c === '"' && depth > 0) inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) out.push(text.slice(start, i + 1));
    }
  }
  return { objects: out, openTail: depth > 0 && start >= 0 ? text.slice(start) : '' };
}

const looksLikeTower = (o) => o && typeof o === 'object' && ('name' in o || 'damageType' in o);

/**
 * Pull the tower object out of whatever the model said. Tries, in order: the
 * whole text, every balanced object (preferring ones that look like a tower,
 * last one wins because models often "correct" themselves), and finally a
 * truncated tail closed by closeJson.
 */
export function extractJson(text) {
  const clean = stripThinking(text);
  if (!clean) return null;
  const whole = tryParse(clean);
  if (whole) return whole;

  const { objects, openTail } = balancedObjects(clean);
  const parsed = objects.map(tryParse).filter(Boolean);
  const towerish = parsed.filter(looksLikeTower);
  if (towerish.length) return towerish[towerish.length - 1];

  if (openTail) {
    const closed = tryParse(closeJson(openTail));
    if (closed) return closed;
  }
  return parsed.length ? parsed[parsed.length - 1] : null;
}

/* ------------------------------------------------------------------ */
/* Validation + repair                                                 */
/* ------------------------------------------------------------------ */

export function normaliseHexColor(value) {
  const m = String(value ?? '').match(/#?\b([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return `#${hex.toLowerCase()}`;
}

export function normaliseShape(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

export function usedSets(used, presets = PRESET_FINGERPRINTS) {
  const names = new Set();
  const types = new Set();
  const shapes = new Set();
  const colors = new Set();
  for (const p of [...presets, ...(used ?? [])]) {
    if (!p) continue;
    if (p.name) names.add(String(p.name).trim().toLowerCase());
    if (p.damageType) types.add(String(p.damageType).trim().toLowerCase());
    if (p.projectileShape) shapes.add(normaliseShape(p.projectileShape));
    const c = normaliseHexColor(p.color);
    if (c) colors.add(c);
  }
  return { names, types, shapes, colors };
}

function clampNum(v, [lo, hi], fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Check a model answer. `problems` are novelty failures worth re-asking the
 * model about; `fixable` lists the ones repairTower() can patch locally.
 */
export function validateTower(tower, used) {
  const sets = usedSets(used);
  const problems = [];
  if (!tower || typeof tower !== 'object' || Array.isArray(tower)) {
    return { ok: false, problems: ['answer was not a JSON object'], hard: true };
  }

  const name = String(tower.name ?? '').trim();
  if (!name) problems.push('missing name');
  else if (sets.names.has(name.toLowerCase())) problems.push(`name "${name}" already used`);

  const damageType = String(tower.damageType ?? '').trim().toLowerCase();
  if (!damageType) problems.push('missing damageType');
  else if (sets.types.has(damageType)) problems.push(`damageType "${damageType}" already used`);

  const shape = normaliseShape(tower.projectileShape);
  if (!shape) problems.push('missing projectileShape');
  else if (sets.shapes.has(shape)) problems.push(`projectileShape "${shape}" already used`);

  const color = normaliseHexColor(tower.color);
  if (!color) problems.push('color must be a hex value like #a1b2c3');
  else if (sets.colors.has(color)) problems.push(`color "${color}" already used`);

  // Only name/damageType need the model's creativity; shape and colour can be patched.
  const hard = problems.some((p) => p.startsWith('missing name') || p.startsWith('name ') || p.includes('damageType'));
  return { ok: problems.length === 0, problems, color, shape, hard };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Pick a colour that is not used, deterministically derived from a seed string. */
export function freshColor(seed, taken) {
  let h = hashString(seed);
  for (let i = 0; i < 64; i++) {
    // Bright-ish colours read best on the dark board.
    const hue = (h % 360) / 360;
    const rgb = hslToRgb(hue, 0.78, 0.58);
    const hex = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    if (!taken.has(hex)) return hex;
    h = Math.imul(h ^ (i + 1), 2654435761) >>> 0;
  }
  return '#c0ffee';
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function uniqueVariant(base, taken, make) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const v = make(base, i);
    if (!taken.has(v.toLowerCase())) return v;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Patch a near-miss locally instead of failing the whole forge: a reused
 * colour/silhouette/name/damage type gets a unique variant. Used on the last
 * attempt, or straight away when only cosmetic fields collided.
 */
export function repairTower(tower, used) {
  const sets = usedSets(used);
  const src = tower && typeof tower === 'object' ? tower : {};
  const seed = JSON.stringify(src).slice(0, 400);

  let name = String(src.name ?? '').trim().slice(0, 28) || 'Foundry Prototype';
  name = uniqueVariant(name, sets.names, (b, i) => `${b.slice(0, 22)} Mk ${roman(i)}`);

  let damageType = String(src.damageType ?? '').trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '') || 'exotic';
  damageType = uniqueVariant(damageType, sets.types, (b, i) => `${b}-${i}`);

  let shape = normaliseShape(src.projectileShape) || 'orb';
  shape = uniqueVariant(shape, sets.shapes, (b, i) => `${b.slice(0, 20)}-${i}`);

  let color = normaliseHexColor(src.color);
  if (!color || sets.colors.has(color)) color = freshColor(seed, sets.colors);

  return { ...src, name, damageType, projectileShape: shape, color };
}

function roman(n) {
  return ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][n] ?? String(n);
}

/** Coerce a validated (or repaired) answer into the wire format the client expects. */
export function finaliseTower(tower) {
  const effect = ALLOWED_EFFECTS.includes(String(tower.effect ?? '').toLowerCase())
    ? String(tower.effect).toLowerCase()
    : 'none';
  return {
    name: String(tower.name).trim().slice(0, 28),
    damageType: String(tower.damageType).trim().toLowerCase().slice(0, 32),
    effect,
    damage: clampNum(tower.damage, LIMITS.damage, 20),
    fireRate: clampNum(tower.fireRate, LIMITS.fireRate, 1),
    range: clampNum(tower.range, LIMITS.range, 4),
    burst: Math.round(clampNum(tower.burst, LIMITS.burst, 1)),
    projectileShape: normaliseShape(tower.projectileShape) || 'orb',
    color: normaliseHexColor(tower.color) ?? '#c0ffee',
    impact: String(tower.impact ?? '').slice(0, 200),
    sound: String(tower.sound ?? '').slice(0, 200),
    mechanic: String(tower.mechanic ?? '').slice(0, 260),
  };
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

export const SYSTEM_PROMPT = 'You are a game designer. You reply with a single valid JSON object and nothing else.';

export function buildPrompt(used, retryNote, brief) {
  const sets = usedSets(used);
  const briefBlock = brief
    ? `
THE PLAYER HAS ASKED FOR THIS SPECIFIC THING:
"${sanitiseBrief(brief)}"

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
names: ${[...sets.names].join(', ')}
damage types: ${[...sets.types].join(', ')}
projectile shapes: ${[...sets.shapes].join(', ')}
colours: ${[...sets.colors].join(', ')}

ALLOWED projectile silhouettes (you may use one of these, or invent a brand new short kebab-case name that is not already used): ${ALLOWED_SHAPES.join(', ')}
ALLOWED effects (pick exactly one, this field must be one of these): ${ALLOWED_EFFECTS.join(', ')}

Rules for the design:
- Give it a NEW kind of damage that does not exist yet (be imaginative: sonic, gravity, magnetic, psychic, arcane, kinetic-vacuum, etc.)
- Give it a NEW projectile silhouette. You MAY invent a short kebab-case silhouette name (for example "coiling-orb", "razor-spindle", "singing-lattice") as long as it is not one of the used ones. Keep it under 20 characters, lowercase, letters and dashes only.
- Give it a NEW colour (hex) that is not already used.
- The impact effect and the sound must be described in ONE short vivid sentence each (under 120 characters), and must be specific to this tower. The mechanic must be under 160 characters. Keep the whole answer compact.
- The "effect" field MUST be exactly one of the allowed effects listed above.
- Numbers: damage 2-260, fireRate 0.25-10 shots per second, range 2.2-9, burst 1-6.
- Balance it: it should feel worth roughly 140-520 gold.
${retryNote ? `\nIMPORTANT: your previous attempt was rejected because: ${retryNote}. Do something completely different - a different name, a different damage type, a different silhouette name and a different colour.` : ''}

Reply with ONLY a JSON object, no prose, no markdown:
{"name":"...","damageType":"...","effect":"...","damage":25,"fireRate":1.2,"range":4.5,"burst":1,"projectileShape":"vortex","color":"#7c4dff","impact":"...","sound":"...","mechanic":"..."}`;
}
