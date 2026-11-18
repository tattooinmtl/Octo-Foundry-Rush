# OCTO FOUNDRY

Industrial tower defense for the phone browser. Three.js renderer, Node.js backend, and an AI
forge (MiniMax, NVIDIA NIM, Reflection AI, Agnes AI, or any OpenAI-/Anthropic-compatible provider)
that invents brand-new towers on demand.

```
npm install
npm run dev      # dev server on :5173 (Vite middleware + API)
npm run build    # production bundle into dist/
npm start        # serves dist/ + API on :3000
npm test         # game + server test suites (no network needed)
npm run lint     # typecheck + syntax-check the server
npm run find-endpoint -- "OpenAI"   # look up a provider's API endpoint
```

## Play it on your phone

The server binds `0.0.0.0`, so any device on the same Wi-Fi can play:

```powershell
ipconfig                      # find "IPv4 Address" on your Wi-Fi adapter, e.g. 192.168.40.5
# open this on the phone:
http://192.168.40.5:3000
```

`npm run dev` uses port 5173 instead. Add the page to the home screen for a full-screen,
chrome-free experience (the manifest meta tags are already in `index.html`).

The play area and the control column are **separate DOM regions**, so the wave panel and the
CALL WAVE button never sit on top of the board.

> **If the phone shows an old version of the game:** the server sends `no-store` for
> `index.html`, so a reload always picks up the newest bundle. If you still see stale UI, close
> the tab and reopen the URL.

## The map

- The road is a **top-to-bottom serpentine that zig-zags exactly 5 times**. Each horizontal
  sweep is separated from the next by two clear rows, so the road never folds over itself, and
  the drops happen at the column where the previous sweep ended.
- Measured over 200 seeds: **exactly 5 zig-zags every time**, road length 27–49 world units,
  **198/200 distinct layouts**, and the road always starts at the top edge and ends at the
  bottom edge.
- **Every cell the road does not use is a build socket** — 92+ per board, drawn as recessed
  steel plates with yellow corner brackets (one instanced mesh, so it costs a single draw
  call). Tapping a socket opens the build sheet; the selected socket gets a glowing marker.
- **Every wave gets a brand new road.** Existing towers migrate to the closest free socket on
  the new route, so your defences survive the map change.
- Because the road is long, **the creeps move faster** (their speed scales with the road
  length) so the kill window — and therefore the balance — stays the same every wave. Their
  leg animation speeds up to match.
- Entry and exit **portals** mark the ends of the road, with a spawn sound on entry and an exit
  sound on escape.

## The AI forge

1. **FORGE NEW TOWER** in the build sheet (180 gold).
2. **Type what you want** in the prompt box — *"a tower that chains freezing lightning between
   groups"*, *"something that burns everything in a long line"*, *"a vacuum that pulls enemies
   together"*. The board **pauses while you type**, so nothing moves under your hands. Leave it
   empty and the forge invents its own idea.
3. The server builds a prompt containing your brief plus every tower that already exists — the 7
   presets plus every tower you have forged — and asks the selected AI provider for one new
   device that honours your request.
4. The answer is validated: the **name**, **damage type**, **projectile silhouette** and
   **colour** must all be new. A reused name or damage type is sent back to the model (up to 3
   attempts); a reused colour/silhouette is repaired locally.
5. The renderer turns the returned silhouette into geometry. Invented names
   (`singing-lattice`, `gravity-well`, `horizon-ring`, …) are hashed onto one of six build
   families, so a brand-new name still produces a distinct-looking projectile and turret.
6. **Power, not price, is normalised**: the model's DPS is clamped into 14–38 and the tower costs
   the flat 180 gold fee, so the forge can never break the economy and the device is deployed
   immediately — there is no second payment.

Your brief is shown back to you on the result card.

### Reliability

- The server retries **timeouts, 5xx, rate limits and empty answers** with exponential backoff
  and jitter (honouring `Retry-After`), but **never** retries a bad key or an exhausted quota -
  those surface straight away so the player sees the real reason.
- Each model call has a hard timeout (`FORGE_TIMEOUT_MS`, default 45 s) and the browser gives
  up after 120 s, so the FORGING... spinner can no longer hang forever.
- JSON recovery handles reasoning blocks (`<think>`, even unclosed), markdown fences, prose
  around the object, a model that "corrects itself" with a second object, trailing commas,
  smart quotes and answers cut off mid-string.
- Out-of-range numbers are clamped instead of burning a retry. A reused colour or silhouette is
  repaired locally; only a reused name/damage type is sent back to the model. If the model
  keeps repeating itself, the last answer is made unique and shipped instead of failing.
- Everything the client sends (brief, model id, used towers) is sanitised, and AI text is
  HTML-escaped before it is shown.

### If the AI can't be reached

The forge degrades instead of dying: it falls back to a **local on-device designer** that reads
your brief by keyword (fire → burn, freeze → chill, chain → chain, pierce → pierce, pull →
gravity…) and still returns a never-repeated name, damage type, silhouette and colour. The
result card tells you which path was used and why:

- `<PROVIDER> QUOTA REACHED` — the account's usage limit was hit (HTTP 429 / quota error).
- `<PROVIDER> REJECTED THE API KEY`, `<PROVIDER> TIMED OUT`, `<PROVIDER> IS DOWN`,
  `<PROVIDER> SENT A BROKEN DESIGN`, `NO API KEY ON THE SERVER`, `CHECK THE PROVIDER SETTINGS`,
  `THE FORGE IS UNREACHABLE` — other causes.

## AI providers

Pick one in **Settings → AI PROVIDER**. Built in (all OpenAI-compatible, checked against the
official docs on 2026-11-18):

| Provider | Base URL | Env key | Default model |
|---|---|---|---|
| MiniMax | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` | `MiniMax-M3.1-Flash` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | `meta/llama-3.3-70b-instruct` |
| Reflection AI | `https://api.reflection.ai/openai/v1` | `REFLECTION_API_KEY` | `Beam-1.0-501B-A23B` |
| Agnes AI | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` | `agnes-2.5-flash` |

The model box is free text with suggestions, so any model the provider offers can be used.

Keys live **on the server** (`.env`, see `.env.example`) or are pasted into Settings, where they
are kept in this browser's localStorage only and sent per request in the `x-api-key` header -
never stored server-side. **Long keys are fine**: the key box is a textarea with no length limit
(Reflection AI keys are about 3x a normal key), pasted line breaks are stripped, and the panel
shows the key length so you can see nothing was cut. Keys up to 8192 characters are accepted.

### Custom provider + SEARCH

Choose **Custom provider…** to use any service. Fill in name, base URL, compatibility
(OpenAI-compatible `POST /chat/completions` or Anthropic-compatible `POST /v1/messages`) and model.

Don't know the endpoint? Press **SEARCH** and type the service name (e.g. "OpenAI"):

1. A built-in table of well-known services answers instantly (OpenAI, Anthropic, xAI, Gemini,
   Groq, Mistral, DeepSeek, Together, OpenRouter, Fireworks, Cerebras, Perplexity, Ollama + the
   four presets).
2. Otherwise the server runs a web search (DuckDuckGo, no key needed), reads the top doc pages,
   pulls out API-looking URLs and scores them (`/chat/completions` → OpenAI, `/v1/messages` or
   `/anthropic` → Anthropic, the service's own `api.` host, "base URL" nearby, ...).
3. The best candidates are probed with `GET <base>/models` **without a key**; a JSON answer
   proves the endpoint exists, Anthropic-style errors flip the compatibility, and a public model
   list pre-fills the model.

The form is pre-filled with the result, its confidence, sources and alternative candidates -
**review it, then press SAVE**. **TEST CONNECTION** probes the endpoint and sends a one-word prompt
with your key. The same lookup works from a terminal: `npm run find-endpoint -- "Groq"`.

Because the server calls the URL you type, LAN/loopback/metadata addresses are blocked unless
`ALLOW_PRIVATE_PROVIDER_URLS=1` (e.g. for a local Ollama).

API: `GET /api/providers`, `GET /api/provider-lookup?name=…`, `POST /api/provider-test`,
`POST /api/forge`, `GET /api/health`.

## The octopus roster

Every octopus has big **googly eyes** whose pupils rattle around on a spring when it hops, turns
or bobs.

| Octopus | From wave | What it does |
|---|---|---|
| Drifter | 1 | Plain purple octopus. |
| Skitter | 1 | Small and quick. |
| Bulwark | 1 (rare before 4) | Armoured and slow. |
| **Hopper** | 3 | Bigger, lime-green, **leaps down the road like a frog**: crouch, spring, land. Same average speed, but it stops and starts. |
| **Glider** | 4 | **Flies on flapping wings**, tentacles dangling, shadow on the road. |
| **Bubbler** | 5 | **Shield bubble** worth 60% of its HP soaks damage (and blocks slows/stuns) until it pops. EMP and shred hit shields 2x. |
| **Fry** | 6 | Tiny, fast, yellow - arrive in threes. |
| **Sky Warden** | 9 | Flying **and** shielded. |
| **Kraken** | 10, 20, ... | Round boss on the 10th wave of each round: huge, armoured, shielded, costs 5 lives if it escapes. |

**Flying rule:** Flame Vent (and any forged tower with a `plume`/`mine` silhouette or `slam`
effect) works on the ground only and cannot hit flyers; dynamite on the road can't either. Every
other tower and the orbital laser / deep freeze / hellfire hit them. Tower cards say **HITS AIR**
or **GROUND ONLY**. The first time a new kind appears, a **NEW FOE** toast explains it.

Balance: spawn weights are tuned so the average HP per wave slot (body + shield, x group size)
stays within a few percent of the original three-creep roster, swarms pay 0.4x gold per fry, and
a Kraken replaces several regular slots - so the 5% power rule below still holds
(`scripts/enemy-test.ts` checks this).

## Save and load

- **Pause → MAIN MENU** saves the run (this used to silently do nothing because the game was
  paused). The run is also autosaved after every cleared wave and when the tab is hidden.
- The save keeps the run seed (so later rounds get the right roads), gold, score, lives, wave,
  round spend, forge count, weapon cooldowns, towers + levels, a held forged tower, and -
  mid-wave - every live octopus (kind, HP, shield, position) plus the rest of the spawn queue.
- Old (v1) saves are migrated automatically. A corrupt save is reported, parked under
  `octo-foundry-save-corrupt` and never half-loaded; bad entries inside a save are dropped
  individually. A lost run's save is cleared.

## Rounds and waves

- A **round = 10 waves**. The panel shows `R2 · 3/10`.
- **The layout only changes on a new round.** All ten waves of a round are fought on the same
  road, so you can learn a map and then take it apart.
- **Each wave has 10% more foes than the wave before it** (compounding: 6, 7, 7, 8, 9, 10, 11,
  12, 13, 14 in round 1), and creep HP climbs continuously across the whole run so a new round
  is never easier than the one before it.
- **A new round resets the board**: every tower is cleared, you get **25% of the gold you spent
  on towers in the last round** back, plus a **fresh starting purse** (the same as round 1),
  and your lives are restored. A fresh road is dealt at the same moment.
- Score carries across rounds — only the board resets.

## The 5% power rule

Everything about the economy is derived from one equation:

```
requiredDps = totalWaveHp / waveDuration
targetDps   = requiredDps × 1.05     ← the player must field 5% MORE than the wave needs
towerBudget = targetDps × 10 gold    ← PRICE_PER_DPS
goldIncome  = towerBudget × 1.28     ← gold the wave pays out
killGold    = (goldIncome − waveBonus) / creepCount
```

So gold income and tower power move together by construction. The HUD shows your live DPS
against the wave target (green when you are at or above it, red when short), and
**Settings → BALANCE** prints the whole table per wave.

## Controls

| Action | How |
|---|---|
| Build | Tap a yellow build pad → pick a tower card |
| Upgrade / sell | Tap a built tower → upgrade (L2/L3) or sell for 70% |
| Dynamite | ◍ button (cost scales with the wave) → tap **the road** to drop it |
| AI forge | Build sheet → **◆ FORGE NEW TOWER** |
| Speed | `1×` / `2×` toggle |
| Pause / mute | Top-right buttons |

**Dynamite** costs 70 + 6×wave gold, fuses for 0.8 s and blasts a 1.9-unit radius:
92 + 26×wave damage, tapering only 35% at the rim, so a charge always kills what it
touches. It can only be dropped **on the road** — tapping anywhere else disarms it with
a warning. Pause is a compact panel in the side column, so the board stays live and you
can pre-place charges before the wave restarts.

## Layout

- `server/index.mjs` — Express API + Vite middleware (dev) / static `dist/` (prod).
- `src/core/path.ts` — procedural corridor carving, corner rounding, pad placement.
- `src/core/balance.ts` — wave maths and the power rule.
- `src/core/enemies.ts` — the octopus creeps: sphere body, four IK legs, per-creep gait,
  googly eyes, leaping, wings, shield bubbles.
- `src/core/towers.ts` / `projectiles.ts` / `effects.ts` — combat.
- `src/core/forge.ts` — forge client, validation, timeout, offline fallback.
- `src/core/save.ts` — save format, validation, v1 → v2 migration.
- `src/core/settings.ts` — settings + per-provider model/key, migration.
- `shared/providers.mjs` — provider presets + known-endpoint table (server and browser).
- `server/forge-core.mjs` — prompt, JSON recovery, validation, repair.
- `server/llm-client.mjs` — OpenAI/Anthropic chat client, timeouts, retries, URL safety.
- `server/endpoint-finder.mjs` — SEARCH: known table, web search, heuristics, probe.
- `src/ui/ui.ts` — all DOM screens.
- `src/core/audio.ts` — every sound is synthesised with WebAudio; no audio files ship.

## Performance

No external assets: all geometry is procedural, all textures are canvas-generated, all audio is
synthesised. The production bundle is **~160 kB gzipped** (three.js is most of it) and there
are no network requests after the page loads.

## Diagnostics

`http://127.0.0.1:3000/?probe=1` paints each board layer a flat colour and prints material,
light and texture facts into the corner of the screen — useful when a surface renders wrong.

`node --import ./scripts/register-ts.mjs scripts/path-test.ts` checks the map generator offline:
uniqueness, turn count, length, pad count and the no-self-touching rule.

`npm test` runs every suite: map, balance, forge (client fallbacks), enemies + waves, save/load,
settings + long keys, and the server (JSON recovery, retries against a mock provider, endpoint
finder heuristics, SSRF guard, `/api/forge` end to end).
