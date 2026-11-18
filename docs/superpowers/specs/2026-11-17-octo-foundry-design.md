# OCTO FOUNDRY — design spec

Date: 2026-11-17 · Status: implemented · Stack: TypeScript + Three.js (r187) + Vite 8 + Express 5 (Node 24)

## 1. Goal

A portrait-first, touch-native browser tower defense that a player opens on a phone and plays
immediately: stable portrait layout, procedural maps, industrial chrome-and-hazard UI, and an
AI forge that invents towers that have never existed in the game before.

## 2. Decisions taken with the user

| Decision | Choice |
|---|---|
| Stack | Node.js project (not a single-file page): Express backend + Vite/TS frontend, Three.js renderer |
| Forge model | `MiniMax-M3.1-Flash` (switchable in Settings) |
| Hosting | Local build only — the player runs the server and opens it over the LAN |
| API key | Server-side; optional per-request override from the Settings panel |
| Scope | Build as specced in the original brief, in one pass |

## 3. Architecture

```
server/index.mjs      Express: POST /api/forge, GET /api/health, static dist/ or Vite middleware
src/main.ts           boots UI + game
src/core/game.ts      orchestrator: scene, run state, wave director, economy, touch input
src/core/path.ts      procedural corridor + rounded curve + build pads
src/core/balance.ts   wave maths, the 5% power rule, price ladder
src/core/enemies.ts   octopus creeps (sphere body, 4 IK legs, per-creep gait)
src/core/towers.ts    aiming and per-effect firing
src/core/projectiles.ts  projectile motion and impact behaviour per effect
src/core/effects.ts   pooled VFX (rings, bursts, beams, lightning, coins)
src/core/forge.ts     forge client + validation + offline fallback
src/core/audio.ts     WebAudio synthesis, no sample files
src/ui/ui.ts          all DOM screens
```

**Data flow.** Input → `Game` (authoritative state) → `UI` (read-only view via `updateHud`)
→ DOM. The game never reads the DOM; the UI never mutates game state except through public
methods. The UI and the game reference each other through a narrow interface, so either side
can be tested alone.

## 4. Map generation

The road is a **serpentine that zig-zags exactly `ZIGZAGS = 5` times** from the top edge to
the bottom edge. Each horizontal sweep is separated from the next by two clear rows, so the road
never touches itself, and the vertical drop between sweeps happens at the column where the
previous sweep finished. Sweep length, start column and direction vary per seed, so no two maps
are the same. Corners are replaced with quadratic Béziers and the curve is resampled at 0.1
units so creeps walk smoothly.

Measured over 200 seeds: exactly 5 zig-zags every time, road length 27–49 world units,
198/200 distinct layouts, road always starts at row 0 and ends at row 15.

**Build sockets: every cell the road does not use** (92+ per board). They are drawn as one
`InstancedMesh` of recessed steel plates with yellow corner brackets, so a hundred sockets cost
a single draw call. A separate marker mesh follows the tapped socket.

**Every wave gets a new road.** `Game.rebuildMap()` regenerates the path at the start of each
wave and migrates every existing tower to the closest free socket on the new route, so defences
survive the map change.

Because the road is long, creep speed scales with road length (`pathLength / 26`) so the kill
window — and therefore the 5% power rule — is identical on every map. Leg animation frequency
scales with the same factor so the gait never looks like a moonwalk.

Entry and exit **portals** mark the road's ends: a flat ground ring plus a standing arch, so the
gate reads from the top-down camera. A spawn sound plays as a creep leaves the entry portal; an
exit sound plays as one escapes through the exit portal.

## 5. Creeps

Sphere body + four two-bone IK legs. Each creep carries a **gait signature**: a gait pattern
(diagonal / wave / gallop / scatter), per-leg frequency multipliers, per-leg phase offsets,
stride length and lift height — all randomised, all different. The result reads as one species
that never moves in lockstep. Tiers: Drifter, Skitter (fast), Bulwark (armoured).

## 6. Towers

Seven hand-built presets (Cannon, Tesla, Frost, Bio, Flame, Scatter, Rail Lance) plus AI-forged
ones. A tower is: base plate → collar → turret → accent material → muzzle anchor. Presets have
bespoke silhouettes; forged towers derive theirs from the projectile style via
`shapeFamily()` in `geo.ts`, which hashes an invented name onto one of six build families.

Firing behaviours: continuous flame cone, hitscan rail beam, chain lightning, and standard
projectiles (arc / homing / pierce / ricochet). Impact behaviour is chosen by damage effect:
splash, burn, chill, pull, volatile, pierce, ricochet, and status effects (shred, stun, mark,
emp).

## 7. The AI forge

Request: `POST /api/forge { used: [{name, damageType, projectileShape, color}], model, brief }`.

The **brief** is the player's own words, typed into the forge panel. Opening the panel pauses the
run (`Game.setForgeOpen`), so the board cannot move while they decide; closing it hands the board
back. The server puts the brief at the top of its prompt and instructs the model to build the
tower around that request while still obeying every constraint below. An empty brief means "you
choose".

Validation enforces **newness** on name, damage type, projectile silhouette and colour;
violations are rejected and regenerated up to 3 times. Truncated JSON is repaired by closing
open strings/braces. The `effect` field is mapped onto the implemented vocabulary; unknown
effects degrade to `none` rather than failing.

Price and DPS are computed **client-side from the returned stats** — the model never sets price,
so a forged tower cannot break the economy. Its DPS is clamped into 14–38 and the flat 180 gold
fee is the price, so the device is deployed immediately.

**Degradation.** If the server call fails, the client falls back to a local on-device designer
that answers the brief by keyword (fire → burn, freeze → chill, chain → chain, pierce → pierce,
pull → gravity…) and still returns a never-repeated name, damage type, silhouette and colour.
The reason is classified and shown to the player: `MINIMAX QUOTA REACHED` (HTTP 429 from the
Token Plan), `MINIMAX IS DOWN`, `NO API KEY ON THE SERVER`, `THE FORGE IS UNREACHABLE`.

## 8. Economy and the 5% rule

```
requiredDps = totalWaveHp / waveDuration
targetDps   = requiredDps × 1.05
towerBudget = targetDps × PRICE_PER_DPS (10)
goldIncome  = towerBudget × INCOME_SLACK (1.28)
killGold    = (goldIncome − waveBonus) / creepCount
```

Tower price = DPS × 10 (rounded to 5). Therefore gold income and purchasable power stay in
lockstep by construction, and the player can always afford slightly more than the wave needs.
The HUD shows live DPS vs. the wave target; Settings prints the per-wave table.

Wave scaling: `hp = 52 × 1.16^(wave−1) + 8 × (round−1)`, creep count = `round base × 1.1^(wave
in round − 1)` where the round base is `6 + 2.2 × (round−1)` (capped at 26), speed
`pathLength / 26` scaled by the wave, armour `min(⌊w/6⌋, 7)`.

## 8b. Rounds

`WAVES_PER_ROUND = 10`. The road is re-dealt **only** at a round boundary, so all ten waves of
a round are fought on the same map. When a round starts (`waveInRound === 1`, wave > 1):

1. every tower is removed,
2. the player is refunded **25% of the gold spent on towers during the previous round**
   (`ROUND_REFUND`), tracked by `Game.roundTowerSpend`,
3. the purse is reset to `START_GOLD + refund` and lives are restored to full,
4. a fresh road is dealt,
5. the score carries over.

The refund scales with the previous round's income, so the reset purse always covers the first
wave of the new round (verified by `scripts/balance-test.ts`).

## 9. Feedback

- **Danger banner**: inverted yellow triangle with a black `!` (construction-site sign), drop
  animation + two-tone klaxon at every wave start.
- **Layout**: the play area (`#stage`) and the control column (`#console`) are separate DOM
  regions, so the square wave panel and its CALL WAVE button can never overlap the board. The
  renderer sizes itself to the stage, not the window.
- **Audio**: one synthesised voice per tower shape, plus impacts, deaths, coins, klaxon,
  wave-clear arpeggio, portal spawn/exit, forge whine and UI clicks. Master/sfx sliders and a
  mute toggle.
- **Scoring**: per-kill points scaled by wave and tier, wave-clear bonus, leak penalty, best
  score persisted.
- **Dynamite**: purchasable, tap-only on the road (tapping elsewhere disarms it with a
  warning), 0.8 s fuse, 1.9-unit blast, 92 + 26×wave damage with only a 35% rim penalty so a
  charge always kills what it touches. The pause panel lives in the side column, so the board
  stays interactive and charges can be pre-placed while paused.

## 9b. Projectile collision

Collision is tested on the **ground plane** (XZ distance), not in 3D: a lobbed shell passes over
a creep's body height, so a 3D test let shells slip through their target. The arc is sized from
the real flight distance so a shell comes back down exactly on the point it aimed at, and shots
**lead** a moving target using its heading and current speed.

Only the `pierce` effect keeps travelling after a hit (it deliberately punches through a crowd);
every other projectile is destroyed by the first enemy it touches, and `ricochet` redirects
once instead of dying.

## 9b. The forge economy

The forge fee (180 gold) **is** the tower's price. The model's damage numbers are normalised so
the finished tower lands in a 14–38 DPS band, then it is deployed on the chosen pad immediately.
There is no second payment and no tower stranded in a bay. If no pad is free, the fee is
refunded and the device waits in the bay.

## 10. Error handling

| Failure | Behaviour |
|---|---|
| No MiniMax key | `/api/forge` → 503 with a readable message; Settings shows the field; the client falls back to a local forge |
| Model repeats itself | Up to 3 attempts, then 422 with the problems; the client falls back to a local forge |
| Model returns truncated JSON | Repaired by closing open strings/braces, then validated |
| Model returns HTTP 429 (Token Plan limit) | Server answers 502 with the reason; the client classifies it as `MINIMAX QUOTA REACHED` and uses the local brief-aware designer |
| Unknown projectile silhouette | Hashed onto a build family; the name is still unique and stored |
| Server offline | Local forge; game continues fully |
| WebAudio blocked | Audio unlock happens on the first tap; before that the game is silent but playable |

## 11. Verification performed

- `tsc --noEmit` clean.
- `vite build` clean (620 kB / 159 kB gzip).
- `GET /` 200, `GET /api/health` reports the key and model list.
- `POST /api/forge` exercised repeatedly against the live MiniMax API: returns new names,
  damage types, silhouettes and colours; duplicates are rejected and regenerated.
- In-browser play check (Chromium, portrait viewport) covering menu → build → wave → warning
  banner → forge.

## 12. Known limitations

- The camera is fixed: the whole board is always framed, no panning or pinch-zoom. This is
  deliberate for touch stability on a phone.
- Creep gait is procedural rather than animation-clipped, so silhouettes are stylised.
- Waves are endless; difficulty is tuned by formula, not by hand-authored content.
