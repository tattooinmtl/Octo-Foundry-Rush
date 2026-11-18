/**
 * UI layer: start screen, the always-open right side panel (status, wave,
 * towers, selected tower, special weapons, system), danger banner, forge
 * modal, settings and game over. Pure DOM - the game talks to it through a
 * small callback interface.
 */

import { game } from '../core/game';
import { PRESETS, type TowerSpec } from '../core/towerDefs';
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
        this.toast('RUN RESTORED');
      } else {
        this.toast('SAVE CORRUPT');
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
      game.saveRun();
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
    $('set-save').addEventListener('click', () => {
      this.applySettingsUi();
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
      const res = await fetch('/api/health');
      const data = await res.json();
      if (data?.keyPresent) {
        el.textContent = `MINIMAX: READY · ${data.model}`;
      } else {
        el.textContent = 'MINIMAX: NO KEY (SETTINGS)';
      }
    } catch {
      el.textContent = 'MINIMAX: SERVER OFFLINE';
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
          info: `<b style="color:${hex(p.color)}">${p.name.toUpperCase()}</b> · ${p.blurb}<br><em>DPS ${dps.toFixed(1)} · RANGE ${p.range.toFixed(1)} · ${p.effect.toUpperCase()}</em>`,
        },
      );
    }

    const spec = game.pendingForge;
    if (spec) {
      add(
        { kind: 'pending' },
        {
          ico: 'forge',
          name: spec.name.toUpperCase(),
          color: spec.color,
          price: () => spec.price,
          cls: 'pending',
          badge: 'READY',
          info: `<b style="color:${hex(spec.color)}">${spec.name.toUpperCase()}</b> · forged and waiting for a pad.<br><em>DPS ${spec.dps.toFixed(1)} · ${spec.projectileShape.toUpperCase()}</em>`,
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
          <span class="sel-stats"><em>DPS <b>${tower.dps.toFixed(1)}</b></em><em>DMG <b>${tower.damage.toFixed(1)}</b></em><em>${spec.effect.toUpperCase()}</em></span>
        </div>
      </div>
      <p class="sel-desc">${spec.mechanic}</p>
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
          <span>&gt; QUERYING MINIMAX…</span><br />
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
      <h3>${spec.name.toUpperCase()}</h3>
      ${brief ? `<p><i>Your brief:</i> ${brief}</p>` : ''}
      ${fallbackReason ? `<p style="color:#ff9a2e"><i>Offline:</i> ${fallbackReason} — this design was generated on the device instead.</p>` : ''}
      <p><b>${spec.damageType.toUpperCase()}</b> damage · ${spec.effect.toUpperCase()} · ${spec.projectileShape.toUpperCase()} projectile</p>
      <p>${spec.mechanic}</p>
      <p><i>Impact:</i> ${spec.impact}</p>
      <p><i>Sound:</i> ${spec.sound}</p>
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

  private refreshSettingsUi(): void {
    $<HTMLInputElement>('set-master').value = String(game.settings.master);
    $<HTMLInputElement>('set-sfx').value = String(game.settings.sfx);
    $<HTMLSelectElement>('set-quality').value = game.settings.quality;
    $<HTMLSelectElement>('set-model').value = game.settings.model;
    $<HTMLInputElement>('set-key').value = game.settings.apiKey;
    this.renderBalance();
  }

  private applySettingsUi(): void {
    game.settings.master = Number($<HTMLInputElement>('set-master').value);
    game.settings.sfx = Number($<HTMLInputElement>('set-sfx').value);
    game.settings.quality = $<HTMLSelectElement>('set-quality').value as 'low' | 'medium' | 'high';
    game.settings.model = $<HTMLSelectElement>('set-model').value;
    game.settings.apiKey = $<HTMLInputElement>('set-key').value.trim();
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
