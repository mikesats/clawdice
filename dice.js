import crypto from 'crypto';
import config from './config.js';

/**
 * ClawDice — Provably Fair Dice Engine
 *
 * Fairness guarantee:
 * 1. Server generates a random seed and commits its SHA256 hash BEFORE the player acts
 * 2. Player provides entropy via Lightning payment preimage (or random in dev mode)
 * 3. Roll = first 2 bytes of HMAC-SHA256(serverSeed, clientEntropy) → uint16 (0–65535)
 * 4. Neither party controls both inputs → neither can manipulate the outcome
 * 5. After the game, server reveals the seed so anyone can verify
 */

// Generate a cryptographically random server seed
export function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

// Commit to a server seed by hashing it
export function commitSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

// Generate the roll from server seed + client entropy (preimage)
export function generateRoll(serverSeed, clientEntropy) {
  const hmac = crypto
    .createHmac('sha256', serverSeed)
    .update(clientEntropy)
    .digest();

  // Take first 2 bytes as uint16 big-endian → 0 to 65535
  const roll = hmac.readUInt16BE(0);
  return roll;
}

// Calculate payout multiplier for a target
export function getMultiplier(target) {
  return config.game.getMultiplier(target);
}

// Determine win/loss and payout
export function resolveGame({ target, betSats, serverSeed, clientEntropy }) {
  const roll = generateRoll(serverSeed, clientEntropy);
  const multiplier = getMultiplier(target);
  const win = roll < target;
  const payoutSats = win ? Math.floor(betSats * multiplier) : 0;

  return {
    roll,
    target,
    result: win ? 'win' : 'loss',
    betSats,
    multiplier: Math.round(multiplier * 1000) / 1000,
    payoutSats,
    serverSeed,
    serverSeedHash: commitSeed(serverSeed),
    clientEntropy,
  };
}

// Verify a past game — anyone can call this to confirm fairness
export function verifyGame({ serverSeed, serverSeedHash, clientEntropy, roll, target }) {
  // Verify the seed commitment
  const computedHash = commitSeed(serverSeed);
  if (computedHash !== serverSeedHash) {
    return { verified: false, reason: 'Server seed does not match committed hash' };
  }

  // Verify the roll
  const computedRoll = generateRoll(serverSeed, clientEntropy);
  if (computedRoll !== roll) {
    return { verified: false, reason: 'Roll does not match HMAC computation' };
  }

  // Verify win/loss
  const expectedResult = roll < target ? 'win' : 'loss';

  return {
    verified: true,
    serverSeed,
    serverSeedHash,
    clientEntropy,
    computedRoll,
    target,
    result: expectedResult,
  };
}

// Generate random client entropy (used in dev mode instead of Lightning preimage)
export function generateDevEntropy() {
  return crypto.randomBytes(32).toString('hex');
}
