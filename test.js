import {
  generateServerSeed,
  commitSeed,
  generateRoll,
  resolveGame,
  verifyGame,
  generateDevEntropy,
  getMultiplier,
} from './dice.js';

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

console.log('');
console.log('🦞🎲 ClawDice — Test Suite');
console.log('═══════════════════════════════════════');

// ── Seed Generation ──────────────────────────────────────
console.log('\n📌 Seed Generation');

const seed1 = generateServerSeed();
const seed2 = generateServerSeed();
assert(seed1.length === 64, 'Server seed is 32 bytes hex (64 chars)');
assert(seed1 !== seed2, 'Seeds are unique');

const hash1 = commitSeed(seed1);
const hash2 = commitSeed(seed1);
assert(hash1 === hash2, 'Same seed → same hash (deterministic)');
assert(hash1.length === 64, 'Hash is SHA256 (64 hex chars)');

// ── Roll Generation ──────────────────────────────────────
console.log('\n🎲 Roll Generation');

const serverSeed = generateServerSeed();
const clientEntropy = generateDevEntropy();

const roll1 = generateRoll(serverSeed, clientEntropy);
const roll2 = generateRoll(serverSeed, clientEntropy);
assert(roll1 === roll2, 'Same inputs → same roll (deterministic)');
assert(roll1 >= 0 && roll1 <= 65535, `Roll in range 0–65535 (got ${roll1})`);

// Different entropy → different roll (overwhelmingly likely)
const otherEntropy = generateDevEntropy();
const roll3 = generateRoll(serverSeed, otherEntropy);
assert(roll1 !== roll3, 'Different entropy → different roll');

// ── Multiplier Calculation ───────────────────────────────
console.log('\n💰 Multiplier Calculation');

const mult50 = getMultiplier(32768); // 50%
assert(Math.abs(mult50 - 1.97) < 0.01, `50% target → ~1.97x (got ${mult50.toFixed(3)})`);

const mult25 = getMultiplier(16384); // 25%
assert(Math.abs(mult25 - 3.94) < 0.01, `25% target → ~3.94x (got ${mult25.toFixed(3)})`);

const mult75 = getMultiplier(49152); // 75%
assert(Math.abs(mult75 - 1.313) < 0.01, `75% target → ~1.31x (got ${mult75.toFixed(3)})`);

// ── Game Resolution ──────────────────────────────────────
console.log('\n🎯 Game Resolution');

const gameResult = resolveGame({
  target: 32768,
  betSats: 100,
  serverSeed,
  clientEntropy,
});

assert(gameResult.roll >= 0 && gameResult.roll <= 65535, 'Roll in valid range');
assert(gameResult.result === 'win' || gameResult.result === 'loss', 'Result is win or loss');
assert(
  (gameResult.result === 'win') === (gameResult.roll < 32768),
  'Win/loss matches roll vs target'
);
if (gameResult.result === 'win') {
  assert(gameResult.payoutSats === Math.floor(100 * gameResult.multiplier), 'Payout = bet × multiplier');
} else {
  assert(gameResult.payoutSats === 0, 'Loss → 0 payout');
}
assert(gameResult.serverSeedHash === commitSeed(serverSeed), 'Seed hash matches');

// ── Verification ─────────────────────────────────────────
console.log('\n🔍 Verification');

const verification = verifyGame({
  serverSeed: gameResult.serverSeed,
  serverSeedHash: gameResult.serverSeedHash,
  clientEntropy: gameResult.clientEntropy,
  roll: gameResult.roll,
  target: 32768,
});

assert(verification.verified === true, 'Honest game verifies correctly');

// Tampered seed should fail
const badVerification = verifyGame({
  serverSeed: generateServerSeed(), // wrong seed
  serverSeedHash: gameResult.serverSeedHash,
  clientEntropy: gameResult.clientEntropy,
  roll: gameResult.roll,
  target: 32768,
});
assert(badVerification.verified === false, 'Tampered seed fails verification');

// Tampered roll should fail
const badRollVerification = verifyGame({
  serverSeed: gameResult.serverSeed,
  serverSeedHash: gameResult.serverSeedHash,
  clientEntropy: gameResult.clientEntropy,
  roll: (gameResult.roll + 1) % 65536, // wrong roll
  target: 32768,
});
assert(badRollVerification.verified === false, 'Tampered roll fails verification');

// ── Statistical Distribution ─────────────────────────────
console.log('\n📊 Statistical Distribution (10,000 rolls at 50% target)');

let wins = 0;
const N = 10000;
for (let i = 0; i < N; i++) {
  const s = generateServerSeed();
  const c = generateDevEntropy();
  const r = generateRoll(s, c);
  if (r < 32768) wins++;
}

const winRate = wins / N;
const expectedRate = 0.5;
const deviation = Math.abs(winRate - expectedRate);

assert(
  deviation < 0.02,
  `Win rate ~50% (got ${(winRate * 100).toFixed(1)}%, deviation ${(deviation * 100).toFixed(2)}%)`
);

// ── House Edge Simulation ────────────────────────────────
console.log('\n🏠 House Edge Simulation (10,000 bets of 100 sats at 50% target)');

let totalWagered = 0;
let totalPaidOut = 0;
for (let i = 0; i < N; i++) {
  const result = resolveGame({
    target: 32768,
    betSats: 100,
    serverSeed: generateServerSeed(),
    clientEntropy: generateDevEntropy(),
  });
  totalWagered += 100;
  totalPaidOut += result.payoutSats;
}

const observedEdge = (totalWagered - totalPaidOut) / totalWagered;
const expectedEdge = 0.015;
const edgeDeviation = Math.abs(observedEdge - expectedEdge);

assert(
  edgeDeviation < 0.015,
  `House edge ~1.5% (got ${(observedEdge * 100).toFixed(2)}%, deviation ${(edgeDeviation * 100).toFixed(2)}%)`
);

console.log(`  → Wagered: ${totalWagered.toLocaleString()} sats`);
console.log(`  → Paid out: ${totalPaidOut.toLocaleString()} sats`);
console.log(`  → House profit: ${(totalWagered - totalPaidOut).toLocaleString()} sats`);

// ── Summary ──────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('');

process.exit(failed > 0 ? 1 : 0);
