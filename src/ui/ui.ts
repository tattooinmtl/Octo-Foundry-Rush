/**
 * UI layer: start screen, the always-open right side panel (status, wave,
 * towers, selected tower, special weapons, system), danger banner, forge
 * modal, settings and game over. Pure DOM - the game talks to it through a
 * small callback interface.
 */

import { game } from '../core/game';
import { PRESETS, canHitFlying, type TowerSpec } from '../core/towerDefs';
import { activeModel, providerShortName } from '../core/settings';
import {
  CUSTOM_PROVIDER_ID,
  PROVIDERS,
  cleanApiKey,
  providerById,
  validateApiKey,
} from '../../shared/providers.mjs';
import { balanceTable, roundOf, waveInRound, WAVES_PER_ROUND } from '../core/balance';
import { audio } from '../core/audio';
import { FORGE_COST, FORGE_LIMIT, WEAPONS, type WeaponId } from '../core/config';
import { icon } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** Escape text that came from an AI model or the network before it goes into innerHTML. */
const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const airTag = (spec: Pick<TowerSpec, 'projectileShape' | 'effect'>) => (canHitFlying(spec) ? 'HITS AIR' : 'GROUND ONLY');
const presetPrice = (p: (typeof PRESETS)[number]) => Math.max(60, Math.round((p.damage * p.fireRate * p.burst * 10) / 5) * 5);

/** What a tower tile builds: a preset, the held forged tower, or the forge. */
type TowerChoice = { kind: 'preset'; id: string } | { kind: 'pending' } | { kind: 'forge' };

export class UI {
  private menu = $('menu');
  private consoleEl = $('console');
  private warning = $('warning');
  private alarm = $('alarm');
  private toastEl = $('toast');
  private forgeModal = $('forge');
  private forgeStatus = $('forge-status');
  private forgeResult = $('forge-result');
  private forgeGo = $<HTMLButtonElement>('forge-go');
  private forgePrompt = $<HTMLTextAreaElement>('forge-prompt');
  private settingsModal = $('settings');
  private gameoverModal = $('gameover');
  private pausedModal = $('paused');
  private towerGrid = $('tower-grid');
  private weaponGrid = $('weapon-grid');
  private towerInfo = $('tower-info');
  private weaponInfo = $('weapon-info');
  private buildHint = $('build-hint');
  private selPanel = $('sel-panel');

  /** Free pad picked on the board, waiting for a tower choice. */
  private selectedPad: string | null = null;
  /** Tower picked first, waiting for a pad click. */
  private armedChoice: TowerChoice | null = null;
  /** Built tower shown in the "selected" section. */
  private shownTowerPad: string | null = null;
  private forgePadId: string | null = null;
  private toastTimer = 0;
  private warningTimer = 0;
  private pendingKey = '';
  private muteShown: boolean | null = null;
  private towerTiles: { el: HTMLButtonElement; choice: TowerChoice; price: () => number }[] = [];
  private weaponTiles: { el: HTMLButtonElement; id: WeaponId }[] = [];

  constructor() {
    this.wire();
    this.buildWeaponGrid();
    this.buildTowerGrid();
    this.refreshSettingsUi();
    void this.checkApi();
    // Countdowns, cooldown sweeps and affordability tick independently of events.
    window.setInterval(() => {
      if (!this.consoleEl.classList.contains('hidden')) this.updateHud();
    }, 200);
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  private wire(): void {
    $('btn-start').addEventListener('click', () => {
      audio.unlock();
      audio.ui('click');
      this.startRun();
    });

    $('btn-load').addEventListener('click', () => {
      audio.unlock();
      audio.ui('click');
      if (!game.hasSave()) {
        this.toast('NO SAVED RUN');
        audio.ui('error');
        return;
      }
      if (game.loadRun()) {
        this.enterGame();
        this.buildTowerGrid();
        this.toast(game.waveActive ? `RUN RESTORED · WAVE ${game.wave} IN PROGRESS` : 'RUN RESTORED');
      } else {
        audio.ui('error');
        this.toast(`SAVE COULD NOT BE LOADED · ${game.lastLoadError.toUpperCase()}`);
      }
    });

    $('btn-settings').addEventListener('click', () => {
      audio.unlock();
      audio.ui('click');
      this.openSettings();
    });
    $('btn-game-settings').innerHTML = icon('settings');
    $('btn-game-settings').addEventListener('click', () => {
      audio.ui('click');
      this.openSettings();
    });

    $('sel-close').addEventListener('click', () => {
      audio.ui('back');
      this.hideTowerPanel();
    });

    $('btn-speed').addEventListener('click', () => {
      game.setSpeed(game.speed === 1 ? 2 : 1);
      audio.ui('click');
      this.updateHud();
    });

    $('btn-mute').addEventListener('click', () => {
      game.settings.muted = !game.settings.muted;
      game.applySettings();
      this.updateHud();
    });

    $('btn-pause').innerHTML = icon('pause');
    $('btn-pause').addEventListener('click', () => {
      audio.ui('click');
      if (game.state === 'playing') {
        game.pause();
        this.pausedModal.classList.remove('hidden');
      }
    });

    $('pause-resume').addEventListener('click', () => {
      game.resume();
      this.pausedModal.classList.add('hidden');
      audio.ui('back');
    });

    $('pause-quit').addEventListener('click', () => {
      if (!game.saveRun()) this.toast('COULD NOT SAVE (STORAGE BLOCKED?)');
      game.quitToMenu();
      this.pausedModal.classList.add('hidden');
      this.toMenu();
      audio.ui('back');
    });

    $('btn-call-wave').addEventListener('click', () => {
      game.callWaveNow();
      audio.ui('click');
    });

    $('forge-go').addEventListener('click', () => {
      void this.runForge();
    });
    $('forge-close').addEventListener('click', () => {
      this.closeForge();
      audio.ui('back');
    });
    // Clicking the dimmed board also closes the forge.
    this.forgeModal.addEventListener('click', (ev) => {
      if (ev.target === this.forgeModal) this.closeForge();
    });

    $('set-close').addEventListener('click', () => {
      this.settingsModal.classList.add('hidden');
      audio.ui('back');
    });
    $('set-provider').addEventListener('change', () => this.switchProvider());
    $('set-key').addEventListener('input', () => this.updateKeyHint());
    $('cp-search').addEventListener('click', () => void this.searchProvider());
    $('set-test').addEventListener('click', () => void this.testProvider());
    $('set-save').addEventListener('click', () => {
      if (!this.applySettingsUi()) return;
      game.applySettings();
      this.settingsModal.classList.add('hidden');
      this.toast('SETTINGS SAVED');
      audio.ui('click');
    });
    $('set-reset').addEventListener('click', () => {
      localStorage.clear();
      game.clearSave();
      this.toast('ALL DATA CLEARED');
      audio.ui('error');
    });

    $('go-restart').addEventListener('click', () => {
      this.gameoverModal.classList.add('hidden');
      this.startRun();
      audio.ui('click');
    });
    $('go-menu').addEventListener('click', () => {
      this.gameoverModal.classList.add('hidden');
      game.quitToMenu();
      this.toMenu();
      audio.ui('back');
    });

    // Stop iOS double-tap zoom on UI controls.
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  private async checkApi(): Promise<void> {
    const el = $('menu-key');
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const who = providerShortName(game.settings);
      const id = game.settings.provider;
      const keyed = !!game.settings.apiKeys[id] || !!data?.keys?.[id];
      el.textContent = keyed ? `${who}: READY · ${activeModel(game.settings)}` : `${who}: NO KEY (SETTINGS)`;
    } catch {
      el.textContent = 'AI FORGE: SERVER OFFLINE';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Screens                                                           */
  /* ---------------------------------------------------------------- */

  private startRun(): void {
    game.newRun();
    this.enterGame();
  }

  private enterGame(): void {
    this.menu.classList.add('hidden');
    this.consoleEl.classList.remove('hidden');
    this.resetSelection();
    this.updateHud();
  }

  private toMenu(): void {
    this.menu.classList.remove('hidden');
    this.consoleEl.classList.add('hidden');
    this.resetSelection();
    this.gameoverModal.classList.add('hidden');
    $('menu-best').textContent = String(game.best);
  }

  private resetSelection(): void {
    this.selectedPad = null;
    this.armedChoice = null;
    this.hideTowerPanel();
  }

  /* ---------------------------------------------------------------- */
  /* Side panel: towers                                                */
  /* ---------------------------------------------------------------- */

  private buildTowerGrid(): void {
    this.towerGrid.innerHTML = '';
    this.towerTiles = [];
    const add = (choice: TowerChoice, opts: { ico: string; name: string; color: number; price: () => number; info: string; cls?: string; badge?: string }) => {
      const el = document.createElement('button');
      el.className = 'tile' + (opts.cls ? ` ${opts.cls}` : '');
      el.style.setProperty('--tc', hex(opts.color));
      el.innerHTML = `
        <span class="tile-ico">${icon(opts.ico)}</span>
        <span class="tile-name">${opts.name}</span>
        <span class="tile-cost">${opts.price()}G</span>
        ${opts.badge ? `<span class="tile-badge">${opts.badge}</span>` : ''}`;
      el.addEventListener('click', () => this.chooseTower(choice));
      el.addEventListener('pointerenter', () => (this.towerInfo.innerHTML = opts.info));
      this.towerGrid.appendChild(el);
      this.towerTiles.push({ el, choice, price: opts.price });
    };

    for (const p of PRESETS) {
      const dps = p.damage * p.fireRate * p.burst;
      add(
        { kind: 'preset', id: p.presetId },
        {
          ico: p.presetId,
          name: p.name.toUpperCase(),
          color: p.color,
          price: () => presetPrice(p),
          info: `<b style="color:${hex(p.color)}">${p.name.toUpperCase()}</b> · ${p.blurb}<br><em>DPS ${dps.toFixed(1)} · RANGE ${p.range.toFixed(1)} · ${p.effect.toUpperCase()} · ${airTag(p)}</em>`,
        },
      );
    }

    const spec = game.pendingForge;
    if (spec) {
      add(
        { kind: 'pending' },
        {
          ico: 'forge',
          name: esc(spec.name.toUpperCase()),
          color: spec.color,
          price: () => spec.price,
          cls: 'pending',
          badge: 'READY',
          info: `<b style="color:${hex(spec.color)}">${esc(spec.name.toUpperCase())}</b> · forged and waiting for a pad.<br><em>DPS ${spec.dps.toFixed(1)} · ${esc(spec.projectileShape.toUpperCase())} · ${airTag(spec)}</em>`,
        },
      );
    }

    add(
      { kind: 'forge' },
      {
        ico: 'forge',
        name: 'AI FORGE',
        color: 0xf5c518,
        price: () => FORGE_COST,
        cls: 'forge',
        badge: `${game.forgedCount}/${FORGE_LIMIT}`,
        info: '<b style="color:#f5c518">AI FORGE</b> · MiniMax invents a tower that does not exist here yet: new damage type, projectile and colour.',
      },
    );
    this.pendingKey = spec ? spec.id : '';
  }

  private sameChoice(a: TowerChoice | null, b: TowerChoice): boolean {
    if (!a || a.kind !== b.kind) return false;
    return a.kind !== 'preset' || (b.kind === 'preset' && a.id === b.id);
  }

  /** A tower tile was pressed. */
  private chooseTower(choice: TowerChoice): void {
    audio.unlock();
    game.cancelWeapon();
    if (this.selectedPad) {
      this.buildOn(this.selectedPad, choice);
      return;
    }
    // No pad yet: arm the tower, the next free pad click builds it.
    this.armedChoice = this.sameChoice(this.armedChoice, choice) ? null : choice;
    audio.ui(this.armedChoice ? 'click' : 'back');
    this.updateHud();
  }

  private buildOn(padId: string, choice: TowerChoice): void {
    if (choice.kind === 'forge') {
      if (!game.canForge) {
        audio.ui('error');
        this.toast(game.forgedCount >= FORGE_LIMIT ? 'FORGE LIMIT REACHED' : 'NOT ENOUGH GOLD');
        return;
      }
      this.openForge(padId);
      this.armedChoice = null;
      this.selectedPad = null;
      return;
    }
    let ok = false;
    if (choice.kind === 'preset') ok = game.buildPreset(choice.id, padId);
    else if (game.pendingForge && game.placeTower(game.pendingForge, padId)) {
      game.pendingForge = null;
      ok = true;
    }
    if (!ok) return; // game already toasted the reason
    this.armedChoice = null;
    this.selectedPad = null;
    this.openTower(padId);
  }

  /* ---------------------------------------------------------------- */
  /* Side panel: special weapons                                       */
  /* ---------------------------------------------------------------- */

  private buildWeaponGrid(): void {
    this.weaponGrid.innerHTML = '';
    this.weaponTiles = [];
    for (const w of WEAPONS) {
      const el = document.createElement('button');
      el.className = 'tile weapon';
      el.style.setProperty('--tc', hex(w.color));
      el.innerHTML = `
        <span class="tile-ico">${icon(w.id)}<span class="cd"></span><b class="cd-num"></b></span>
        <span class="tile-name">${w.name.toUpperCase()}</span>
        <span class="tile-cost"></span>`;
      el.addEventListener('pointerenter', () => {
        const cd = w.cooldown > 0 ? ` · ${w.cooldown}s RECHARGE` : '';
        this.weaponInfo.innerHTML = `<b style="color:${hex(w.color)}">${w.name.toUpperCase()}</b> · ${w.blurb}<br><em>RADIUS ${w.radius.toFixed(1)}${cd}</em>`;
      });
      el.addEventListener('click', () => {
        audio.unlock();
        this.armedChoice = null;
        game.armWeapon(w.id);
        this.updateHud();
      });
      this.weaponGrid.appendChild(el);
      this.weaponTiles.push({ el, id: w.id });
    }
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                               */
  /* ---------------------------------------------------------------- */

  updateHud(): void {
    $('hud-gold').textContent = String(Math.floor(game.gold));
    $('hud-wave').textContent = String(game.wave);
    $('hud-score').textContent = String(game.score);
    $('hud-lives').textContent = String(Math.max(0, game.lives));
    $('btn-speed').innerHTML = `${icon('speed')}<em>${game.speed}×</em>`;
    if (this.muteShown !== game.settings.muted) {
      this.muteShown = game.settings.muted;
      $('btn-mute').innerHTML = icon(game.settings.muted ? 'mute' : 'sound');
    }

    // Wave meter.
    $('wm-wave').textContent = `R${roundOf(game.wave)} · ${waveInRound(game.wave)}/${WAVES_PER_ROUND}`;
    if (game.waveActive) {
      const total = game.wavePlan?.count ?? 1;
      const left = game.enemies.length + game.spawnQueue.length;
      $('wm-timer').textContent = `${left} LEFT`;
      $('wm-fill').style.width = `${Math.max(0, Math.min(100, ((total - left) / total) * 100))}%`;
    } else {
      $('wm-timer').textContent = `NEXT ${Math.max(0, Math.ceil(game.nextWaveIn))}s`;
      $('wm-fill').style.width = `${Math.max(0, Math.min(100, (1 - game.nextWaveIn / 12) * 100))}%`;
    }

    // Power vs the 5% rule.
    const target = game.targetDps;
    const mine = game.playerDps;
    const ratio = target > 0 ? mine / target : 1;
    const max = Math.max(target * 1.6, mine * 1.05, 1);
    $('power-fill').style.width = `${Math.min(100, (mine / max) * 100)}%`;
    $('power-target').style.left = `${Math.min(100, (target / max) * 100)}%`;
    const text = $('power-text');
    text.textContent = `${Math.round(mine)} / ${Math.round(target)}`;
    text.className = ratio >= 1 ? 'ok' : 'under';

    // Tower tiles.
    if ((game.pendingForge?.id ?? '') !== this.pendingKey) this.buildTowerGrid();
    for (const t of this.towerTiles) {
      const price = t.price();
      t.el.classList.toggle('poor', game.gold < price);
      t.el.classList.toggle('armed', this.sameChoice(this.armedChoice, t.choice));
      t.el.classList.toggle('ready', !!this.selectedPad);
      const cost = t.el.querySelector('.tile-cost');
      if (cost) cost.textContent = `${price}G`;
      if (t.choice.kind === 'forge') {
        const b = t.el.querySelector('.tile-badge');
        if (b) b.textContent = `${game.forgedCount}/${FORGE_LIMIT}`;
      }
    }
    this.buildHint.textContent = this.selectedPad
      ? 'PAD SELECTED · PICK A TOWER'
      : this.armedChoice
        ? 'NOW TAP A FREE PAD'
        : 'TAP A PAD OR A TOWER';
    this.buildHint.classList.toggle('live', !!this.selectedPad || !!this.armedChoice);

    // Weapon tiles.
    for (const w of this.weaponTiles) {
      const cost = game.weaponCost(w.id);
      const cd = game.cooldownFraction(w.id);
      w.el.classList.toggle('poor', game.gold < cost);
      w.el.classList.toggle('armed', game.armedWeapon === w.id);
      w.el.classList.toggle('cooling', cd > 0);
      w.el.style.setProperty('--cd', String(cd));
      (w.el.querySelector('.tile-cost') as HTMLElement).textContent = `${cost}G`;
      (w.el.querySelector('.cd-num') as HTMLElement).textContent = cd > 0 ? `${Math.ceil(game.cooldowns[w.id])}` : '';
    }

    // Keep the tower panel in sync (gold changes the upgrade button state).
    if (this.shownTowerPad) {
      const tower = game.towers.find((t) => t.padId === this.shownTowerPad);
      if (!tower) this.hideTowerPanel();
      else {
        const up = this.selPanel.querySelector('.up') as HTMLElement | null;
        if (up) up.classList.toggle('poor', game.gold < tower.upgradeCost);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Warning banner                                                    */
  /* ---------------------------------------------------------------- */

  waveWarning(wave: number): void {
    $('warn-wave').textContent = String(waveInRound(wave));
    $('warn-round').textContent = String(roundOf(wave));
    for (const el of [this.warning, this.alarm]) {
      el.classList.remove('hidden');
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }
    window.clearTimeout(this.warningTimer);
    this.warningTimer = window.setTimeout(() => {
      this.warning.classList.add('hidden');
      this.alarm.classList.add('hidden');
    }, 2800);
  }

  waveCleared(plan: { wave: number }, bonus: number): void {
    this.toast(`WAVE ${plan.wave} CLEARED · +${bonus} GOLD`);
  }

  gameOver(): void {
    $('go-score').textContent = String(game.score);
    $('go-best').textContent = String(game.best);
    $('go-wave').textContent = String(roundOf(game.wave));
    this.gameoverModal.classList.remove('hidden');
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('show');
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2000);
  }

  /* ---------------------------------------------------------------- */
  /* Board callbacks                                                   */
  /* ---------------------------------------------------------------- */

  /** A free pad (or the road, '__none__') was tapped on the board. */
  openBuild(padId: string): void {
    this.hideTowerPanel();
    if (padId === '__none__') {
      this.selectedPad = null;
      this.updateHud();
      return;
    }
    if (this.armedChoice) {
      this.buildOn(padId, this.armedChoice);
      this.updateHud();
      return;
    }
    this.selectedPad = padId;
    audio.ui('click');
    this.updateHud();
  }

  /** A built tower was tapped: show it in the "selected" section. */
  openTower(padId: string): void {
    const tower = game.towers.find((t) => t.padId === padId);
    if (!tower) return;
    this.selectedPad = null;
    this.shownTowerPad = padId;
    const spec = tower.spec;
    $('sel-title').textContent = spec.name.toUpperCase();
    const body = $('sel-body');
    const icoName = spec.kind === 'preset' ? spec.presetId : 'forge';
    const stars = [1, 2, 3].map((l) => `<i class="${l <= tower.level ? 'on' : ''}">★</i>`).join('');
    body.innerHTML = `
      <div class="sel-card" style="--tc:${hex(spec.color)}">
        <span class="tile-ico">${icon(icoName)}</span>
        <div class="sel-meta">
          <span class="sel-level">${stars}</span>
          <span class="sel-stats"><em>DPS <b>${tower.dps.toFixed(1)}</b></em><em>DMG <b>${tower.damage.toFixed(1)}</b></em><em>${spec.effect.toUpperCase()}</em><em>${airTag(spec)}</em></span>
        </div>
      </div>
      <p class="sel-desc">${esc(spec.mechanic)}</p>
      <div class="sel-actions"></div>`;
    const actions = body.querySelector('.sel-actions') as HTMLElement;
    if (tower.level < 3) {
      const up = document.createElement('button');
      up.className = 'mbtn primary up';
      up.innerHTML = `▲ UPGRADE · ${tower.upgradeCost}G`;
      if (game.gold < tower.upgradeCost) up.classList.add('poor');
      up.addEventListener('click', () => {
        if (game.upgradeTower(padId)) this.openTower(padId);
      });
      actions.appendChild(up);
    }
    const sell = document.createElement('button');
    sell.className = 'mbtn';
    sell.innerHTML = `SELL · +${tower.sellValue}G`;
    sell.addEventListener('click', () => {
      game.sellTower(padId);
      this.hideTowerPanel();
    });
    actions.appendChild(sell);
    this.selPanel.classList.remove('hidden');
    this.selPanel.classList.remove('pop');
    void this.selPanel.offsetWidth;
    this.selPanel.classList.add('pop');
    this.updateHud();
  }

  private hideTowerPanel(): void {
    this.shownTowerPad = null;
    this.selPanel.classList.add('hidden');
  }

  private openForge(padId: string): void {
    this.forgePadId = padId;
    this.forgeModal.classList.remove('hidden');
    this.forgeResult.classList.add('hidden');
    this.forgePrompt.value = '';
    this.setForgeBusy(false);
    // The board freezes while the player writes the brief.
    game.setForgeOpen(true);
    this.updateHud();
    audio.ui('click');
    setTimeout(() => this.forgePrompt.focus(), 60);
  }

  /* ---------------------------------------------------------------- */
  /* Forge                                                             */
  /* ---------------------------------------------------------------- */

  setForgeBusy(busy: boolean): void {
    this.forgeGo.disabled = busy;
    this.forgeGo.textContent = busy ? 'FORGING…' : `FORGE · ${FORGE_COST}G`;
    if (busy) {
      this.forgeResult.classList.add('hidden');
      this.forgeStatus.innerHTML = `
        <div class="gear"></div>
        <div class="forge-lines">
          <span>&gt; QUERYING ${esc(providerShortName(game.settings))}…</span><br />
          <span>&gt; CHECKING NOVELTY…</span><br />
          <span>&gt; FORGING GEOMETRY…</span>
        </div>`;
    } else {
      this.forgeStatus.innerHTML = `
        <div class="gear"></div>
        <div class="forge-lines"><span>READY TO FORGE</span></div>`;
    }
  }

  private async runForge(): Promise<void> {
    if (!this.forgePadId) return;
    const padId = this.forgePadId;
    const brief = this.forgePrompt.value.trim();
    this.setForgeBusy(true);
    await game.forgeNewTower(padId, brief);
    this.setForgeBusy(false);
  }

  /** Close the forge panel and hand the board back to the player. */
  private closeForge(): void {
    this.forgeModal.classList.add('hidden');
    game.setForgeOpen(false);
    this.updateHud();
  }

  showForgeResult(spec: TowerSpec, placed: boolean, fallbackReason?: string): void {
    const brief = this.forgePrompt.value.trim();
    this.forgeResult.classList.remove('hidden');
    this.forgeResult.innerHTML = `
      <h3>${esc(spec.name.toUpperCase())}</h3>
      ${brief ? `<p><i>Your brief:</i> ${esc(brief)}</p>` : ''}
      ${fallbackReason ? `<p style="color:#ff9a2e"><i>Offline:</i> ${esc(fallbackReason)} — this design was generated on the device instead.</p>` : ''}
      <p><b>${esc(spec.damageType.toUpperCase())}</b> damage · ${esc(spec.effect.toUpperCase())} · ${esc(spec.projectileShape.toUpperCase())} projectile · ${airTag(spec)}</p>
      <p>${esc(spec.mechanic)}</p>
      <p><i>Impact:</i> ${esc(spec.impact)}</p>
      <p><i>Sound:</i> ${esc(spec.sound)}</p>
      <div class="fr-stats">
        <span>DPS ${spec.dps.toFixed(1)}</span>
        <span>DMG ${spec.damage.toFixed(1)}</span>
        <span>FIRE ${spec.fireRate.toFixed(2)}/s</span>
        <span>RNG ${spec.range.toFixed(1)}</span>
        <span style="color:#f5c518">${spec.price}G</span>
      </div>
      <p style="margin-top:8px;color:${placed ? '#37d67a' : '#ff9a2e'}">
        ${placed ? 'DEPLOYED ON THE PAD' : 'HELD IN THE BAY - PLACE IT WHEN YOU CAN AFFORD IT'}
      </p>
    `;
    this.forgeStatus.innerHTML = `
      <div class="gear" style="animation:none;border-style:solid"></div>
      <div class="forge-lines"><span>FORGE COMPLETE</span></div>`;
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  /* Working copy of the provider fields while the settings panel is open,
     so switching providers back and forth does not lose what was typed. */
  private draftModels: Record<string, string> = {};
  private draftKeys: Record<string, string> = {};
  private draftProvider = '';

  private refreshSettingsUi(): void {
    $<HTMLInputElement>('set-master').value = String(game.settings.master);
    $<HTMLInputElement>('set-sfx').value = String(game.settings.sfx);
    $<HTMLSelectElement>('set-quality').value = game.settings.quality;

    const sel = $<HTMLSelectElement>('set-provider');
    sel.innerHTML = [
      ...PROVIDERS.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`),
      `<option value="${CUSTOM_PROVIDER_ID}">Custom provider…</option>`,
    ].join('');
    this.draftModels = { ...game.settings.models, [CUSTOM_PROVIDER_ID]: game.settings.custom.model };
    this.draftKeys = { ...game.settings.apiKeys };
    this.draftProvider = game.settings.provider;
    sel.value = game.settings.provider;
    $<HTMLInputElement>('cp-name').value = game.settings.custom.name;
    $<HTMLInputElement>('cp-url').value = game.settings.custom.baseUrl;
    $<HTMLSelectElement>('cp-compat').value = game.settings.custom.compat;
    $('cp-result').innerHTML = '';
    this.showProviderFields(game.settings.provider);
    this.renderBalance();
  }

  /** Fill model/key/custom fields for one provider. */
  private showProviderFields(id: string): void {
    const preset = providerById(id);
    const isCustom = id === CUSTOM_PROVIDER_ID;
    $('custom-provider').classList.toggle('hidden', !isCustom);
    const list = $('set-model-list');
    list.innerHTML = (preset?.models ?? []).map((m) => `<option value="${esc(m)}"></option>`).join('');
    const model = $<HTMLInputElement>('set-model');
    model.value = this.draftModels[id] ?? preset?.defaultModel ?? '';
    model.placeholder = isCustom ? 'model id from the provider docs' : preset?.defaultModel ?? '';
    $<HTMLTextAreaElement>('set-key').value = this.draftKeys[id] ?? '';
    $<HTMLTextAreaElement>('set-key').placeholder = preset
      ? `server key (${preset.envKey}) is used when blank`
      : 'server key (CUSTOM_API_KEY) is used when blank';
    this.updateKeyHint();
  }

  /** Remember the fields of the provider being left, then show the new one. */
  private switchProvider(): void {
    const prev = this.draftProvider;
    this.draftModels[prev] = $<HTMLInputElement>('set-model').value.trim();
    this.draftKeys[prev] = cleanApiKey($<HTMLTextAreaElement>('set-key').value);
    this.draftProvider = $<HTMLSelectElement>('set-provider').value;
    this.showProviderFields(this.draftProvider);
    $('cp-result').innerHTML = '';
  }

  /** Show the key length so a very long key (Reflection) is visibly kept whole. */
  private updateKeyHint(): void {
    const key = cleanApiKey($<HTMLTextAreaElement>('set-key').value);
    const preset = providerById(this.draftProvider);
    const long = preset?.longKey ? ' · long keys are fine, paste it all' : '';
    $('set-key-hint').textContent = key ? `${key.length} chars${long}` : preset?.longKey ? 'long keys are fine' : '';
  }

  /** Validate and store the panel. Returns false (and keeps the panel open) on a problem. */
  private applySettingsUi(): boolean {
    const provider = $<HTMLSelectElement>('set-provider').value;
    const keyCheck = validateApiKey($<HTMLTextAreaElement>('set-key').value);
    if (!keyCheck.ok) {
      this.toast(`API KEY: ${keyCheck.problem.toUpperCase()}`);
      audio.ui('error');
      return false;
    }
    const model = $<HTMLInputElement>('set-model').value.trim();
    const custom = {
      name: $<HTMLInputElement>('cp-name').value.trim().slice(0, 60),
      baseUrl: $<HTMLInputElement>('cp-url').value.trim(),
      compat: ($<HTMLSelectElement>('cp-compat').value === 'anthropic' ? 'anthropic' : 'openai') as 'openai' | 'anthropic',
      model: provider === CUSTOM_PROVIDER_ID ? model : this.draftModels[CUSTOM_PROVIDER_ID] ?? game.settings.custom.model,
    };
    if (provider === CUSTOM_PROVIDER_ID) {
      if (!/^https?:\/\/[^\s]+$/i.test(custom.baseUrl)) {
        this.toast('CUSTOM PROVIDER NEEDS A BASE URL (TRY SEARCH)');
        audio.ui('error');
        return false;
      }
      if (!custom.model) {
        this.toast('CUSTOM PROVIDER NEEDS A MODEL NAME');
        audio.ui('error');
        return false;
      }
    }
    this.draftModels[provider] = model;
    this.draftKeys[provider] = keyCheck.key;

    game.settings.master = Number($<HTMLInputElement>('set-master').value);
    game.settings.sfx = Number($<HTMLInputElement>('set-sfx').value);
    game.settings.quality = $<HTMLSelectElement>('set-quality').value as 'low' | 'medium' | 'high';
    game.settings.provider = provider;
    for (const p of PROVIDERS) {
      const m = (this.draftModels[p.id] ?? '').trim();
      game.settings.models[p.id] = m || p.defaultModel;
    }
    game.settings.apiKeys = Object.fromEntries(Object.entries(this.draftKeys).filter(([, v]) => !!v));
    game.settings.custom = custom;
    void this.checkApi();
    return true;
  }

  private setResult(html: string): void {
    $('cp-result').innerHTML = html;
  }

  /**
   * SEARCH: ask for the service name, look the endpoint up (built-in table,
   * then web search on the server) and pre-fill the custom form for review.
   */
  private async searchProvider(): Promise<void> {
    const nameEl = $<HTMLInputElement>('cp-name');
    const name = window.prompt('Which AI service are you looking for? (e.g. OpenAI, Groq, Mistral)', nameEl.value.trim());
    if (!name || !name.trim()) return;
    const btn = $<HTMLButtonElement>('cp-search');
    btn.disabled = true;
    this.setResult(`<p class="cp-busy">SEARCHING FOR <b>${esc(name.toUpperCase())}</b> ENDPOINT…</p>`);
    try {
      const res = await fetch(`/api/provider-lookup?name=${encodeURIComponent(name.trim())}`, { signal: AbortSignal.timeout(45000) });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!data?.ok) {
        this.setResult(`<p class="cp-bad">${esc(data?.error ?? 'Nothing found.')} You can still fill the form by hand.</p>`);
        return;
      }
      this.applyLookup(data, name.trim());
    } catch {
      this.setResult('<p class="cp-bad">Search failed (server offline or timed out). Fill the form by hand.</p>');
    } finally {
      btn.disabled = false;
    }
  }

  private applyLookup(data: any, typedName: string): void {
    $<HTMLInputElement>('cp-name').value = String(data.name || typedName).slice(0, 60);
    $<HTMLInputElement>('cp-url').value = String(data.baseUrl ?? '');
    $<HTMLSelectElement>('cp-compat').value = data.compat === 'anthropic' ? 'anthropic' : 'openai';
    const model = $<HTMLInputElement>('set-model');
    if (data.model && !model.value.trim()) model.value = String(data.model);
    const pct = Math.round(Number(data.confidence ?? 0) * 100);
    const src = data.source === 'known' ? 'BUILT-IN TABLE' : 'WEB SEARCH';
    const links = (Array.isArray(data.sources) ? data.sources : [])
      .slice(0, 3)
      .map((u: string) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u.replace(/^https?:\/\//, '').slice(0, 60))}</a>`)
      .join('<br>');
    const alts = (Array.isArray(data.candidates) ? data.candidates : []).slice(1, 4);
    this.setResult(`
      <p class="cp-good">FOUND VIA ${src} · ${pct}% SURE${data.verified ? ' · VERIFIED' : ''}</p>
      <p><b>${esc(data.baseUrl)}</b> · ${data.compat === 'anthropic' ? 'Anthropic' : 'OpenAI'}-compatible</p>
      <p class="cp-note">${esc(data.notes ?? '')} Review the fields above, add the model and key, then press SAVE.</p>
      ${links ? `<p class="cp-src">${links}</p>` : ''}
      ${alts.length ? `<p class="cp-note">Other candidates:</p><div class="cp-alts">${alts
        .map((c: any, i: number) => `<button type="button" class="mbtn cp-alt" data-i="${i}">${esc(c.baseUrl)} · ${c.compat === 'anthropic' ? 'ANTHROPIC' : 'OPENAI'}</button>`)
        .join('')}</div>` : ''}`);
    $('cp-result')
      .querySelectorAll<HTMLButtonElement>('.cp-alt')
      .forEach((b) =>
        b.addEventListener('click', () => {
          const c = alts[Number(b.dataset.i)];
          $<HTMLInputElement>('cp-url').value = String(c.baseUrl);
          $<HTMLSelectElement>('cp-compat').value = c.compat === 'anthropic' ? 'anthropic' : 'openai';
        }),
      );
  }

  /** TEST CONNECTION: probe the endpoint and, if a key is available, send a tiny prompt. */
  private async testProvider(): Promise<void> {
    const provider = $<HTMLSelectElement>('set-provider').value;
    const keyCheck = validateApiKey($<HTMLTextAreaElement>('set-key').value);
    if (!keyCheck.ok) {
      this.setResult(`<p class="cp-bad">API key: ${esc(keyCheck.problem)}</p>`);
      return;
    }
    const btn = $<HTMLButtonElement>('set-test');
    btn.disabled = true;
    this.setResult('<p class="cp-busy">TESTING…</p>');
    try {
      const res = await fetch('/api/provider-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(keyCheck.key ? { 'x-api-key': keyCheck.key } : {}) },
        body: JSON.stringify({
          provider,
          model: $<HTMLInputElement>('set-model').value.trim(),
          custom: {
            name: $<HTMLInputElement>('cp-name').value.trim(),
            baseUrl: $<HTMLInputElement>('cp-url').value.trim(),
            compat: $<HTMLSelectElement>('cp-compat').value,
            model: $<HTMLInputElement>('set-model').value.trim(),
          },
        }),
        signal: AbortSignal.timeout(40000),
      });
      const data = await res.json();
      if (!data.ok) {
        this.setResult(`<p class="cp-bad">${esc(data.error)}</p>`);
        return;
      }
      const probe = data.probe?.reachable ? `endpoint answered (HTTP ${data.probe.status})` : 'endpoint did not answer GET /models (some providers do not expose it)';
      const chat = !data.keyPresent
        ? 'no key to test with - paste one or set it on the server'
        : data.chat?.ok
          ? `model replied: “${esc(data.chat.sample)}”`
          : `chat failed: ${esc(data.chat?.error ?? 'unknown')}`;
      const cls = data.chat?.ok ? 'cp-good' : data.keyPresent ? 'cp-bad' : 'cp-note';
      this.setResult(`<p class="${cls}">${esc(data.baseUrl)} · ${esc(data.model)}</p><p class="cp-note">${esc(probe)}<br>${chat}</p>`);
    } catch {
      this.setResult('<p class="cp-bad">Test failed (server offline or timed out).</p>');
    } finally {
      btn.disabled = false;
    }
  }

  private renderBalance(): void {
    const host = $('balance-table');
    const length = game.path?.length ?? 24;
    const rows = balanceTable(length, 14);
    host.innerHTML = `
      <table>
        <thead><tr><th>WAVE</th><th>HP</th><th>NEED</th><th>TARGET</th><th>GOLD</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) =>
                `<tr><td>${r.wave}</td><td>${r.totalHp}</td><td>${r.requiredDps}</td><td>${r.targetDps}</td><td>${r.goldIncome}</td></tr>`,
            )
            .join('')}
        </tbody>
      </table>`;
  }

  openSettings(): void {
    this.refreshSettingsUi();
    this.settingsModal.classList.remove('hidden');
  }
}
