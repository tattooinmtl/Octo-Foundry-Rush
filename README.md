# OCTO FOUNDRY

Industrial tower defense for the phone browser. Three.js renderer, Node.js backend, MiniMax
forges brand-new towers on demand.

```
npm install
npm run dev      # dev server on :5173 (Vite middleware + API)
npm run build    # production bundle into dist/
npm start        # serves dist/ + API on :3000
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
   presets plus every tower you have forged — and asks MiniMax for one new device that honours
   your request.
4. The answer is validated: the **name**, **damage type**, **projectile silhouette** and
   **colour** must all be new. A duplicate is rejected and regenerated (up to 3 attempts).
5. The renderer turns the returned silhouette into geometry. Invented names
   (`singing-lattice`, `gravity-well`, `horizon-ring`, …) are hashed onto one of six build
   families, so a brand-new name still produces a distinct-looking projectile and turret.
6. **Power, not price, is normalised**: the model's DPS is clamped into 14–38 and the tower costs
   the flat 180 gold fee, so the forge can never break the economy and the device is deployed
   immediately — there is no second payment.

Your brief is shown back to you on the result card.

### If MiniMax can't be reached

The forge degrades instead of dying: it falls back to a **local on-device designer** that reads
your brief by keyword (fire → burn, freeze → chill, chain → chain, pierce → pierce, pull →
gravity…) and still returns a never-repeated name, damage type, silhouette and colour. The
result card tells you which path was used and why:

- `MINIMAX QUOTA REACHED` — the account's Token Plan usage limit was hit (MiniMax HTTP 429).
  Buy credits or wait for the plan to reset to get the real thing back.
- `MINIMAX IS DOWN` / `NO API KEY ON THE SERVER` / `THE FORGE IS UNREACHABLE` — other causes.

## The MiniMax key

The key lives **on the server**, never in the browser payload:

- `MINIMAX_API_KEY` in `.env` (already created, git-ignored), **or**
- the Windows user environment, **or**
- pasted into the in-game **Settings** panel — sent per request via the `x-api-key` header
  and never stored server-side.

```powershell
# GET /api/health -> { keyPresent, model, models[] }
```

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
- `src/core/enemies.ts` — the octopus creeps: sphere body, four IK legs, per-creep gait.
- `src/core/towers.ts` / `projectiles.ts` / `effects.ts` — combat.
- `src/core/forge.ts` — forge client, validation, offline fallback.
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
