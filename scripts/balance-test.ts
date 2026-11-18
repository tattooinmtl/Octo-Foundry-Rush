/**
 * Offline check of the round/wave economy.
 * Run: node --import ./scripts/register-ts.mjs scripts/balance-test.ts
 */
import { planWave, roundOf, waveInRound, WAVES_PER_ROUND, PRICE_PER_DPS, POWER_MARGIN, ROUND_REFUND } from '../src/core/balance.ts';
import { START_GOLD } from '../src/core/config.ts';

const PATH_LENGTH = 38; // typical length of the 5-zigzag road

let gold = START_GOLD;
let roundSpend = 0;

console.log('round wave | foes |    hp | totalHP | needDPS | targetDPS | waveGold | purse');
for (let wave = 1; wave <= 30; wave++) {
  const p = planWave(wave, PATH_LENGTH);

  // A new round wipes the board: 25% of the round's tower spend comes back
  // plus a fresh starting purse.
  if (waveInRound(wave) === 1 && wave > 1) {
    const refund = Math.round(roundSpend * ROUND_REFUND);
    gold = START_GOLD + refund;
    roundSpend = 0;
    console.log(`  >>> ROUND ${roundOf(wave)} RESET: +${refund}g refund, purse ${gold}g`);
  }

  // The player spends everything the wave pays out on towers.
  const spend = Math.min(gold, p.goldIncome);
  gold -= spend;
  roundSpend += spend;
  gold += p.goldIncome;

  const tag = waveInRound(wave) === 1 || wave <= 2 ? `  <<<` : '';
  console.log(
    `${String(roundOf(wave)).padStart(5)} ${String(waveInRound(wave)).padStart(4)} |` +
      `${String(p.count).padStart(4)} |${String(p.hpPerCreep).padStart(5)} |` +
      `${String(p.totalHp).padStart(8)} |${p.requiredDps.toFixed(1).padStart(7)} |` +
      `${p.targetDps.toFixed(1).padStart(9)} |${String(p.goldIncome).padStart(9)} |` +
      `${String(Math.round(gold)).padStart(6)}${tag}`,
  );
}

// The 5% rule and the foe ramp.
const w1 = planWave(1, PATH_LENGTH);
const w2 = planWave(2, PATH_LENGTH);
console.log('\n5% rule  : target/need =', (w1.targetDps / w1.requiredDps).toFixed(4), '(want', POWER_MARGIN + ')');
console.log('foe ramp : wave2/wave1 =', (w2.count / w1.count).toFixed(3), '(~1.10)');
console.log('wave budget =', Math.round(w1.targetDps * PRICE_PER_DPS), 'gold for wave 1');
console.log('waves per round =', WAVES_PER_ROUND);
