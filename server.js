import express from 'express';
import config from './config.js';
import {
  generateServerSeed,
  commitSeed,
  resolveGame,
  verifyGame,
  generateDevEntropy,
  getMultiplier,
} from './dice.js';
import { initDb, generateGameId, saveGame, getGame, getStats, getLeaderboard, getRecentGames } from './db.js';
import { sendPayout } from './payout.js';

const app = express();
app.use(express.json());

// ──────────────────────────────────────────────────────────
// MIDDLEWARE
// ──────────────────────────────────────────────────────────

// In production, Aperture sits in front and handles L402.
// The preimage comes through as part of the L402 authorization header.
// In dev mode, we simulate client entropy.

function extractClientEntropy(req) {
  // Production: extract preimage from L402 Authorization header
  // Format: "L402 <macaroon>:<preimage>"
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('L402 ')) {
    const parts = authHeader.split(':');
    if (parts.length >= 2) {
      return parts[parts.length - 1].trim();
    }
  }

  // Dev mode: generate random entropy
  if (config.devMode) {
    return generateDevEntropy();
  }

  return null;
}

function extractPlayerPubkey(req) {
  // From L402 macaroon metadata, custom header, or query param
  return req.headers['x-player-pubkey'] || req.query.pubkey || null;
}

// ──────────────────────────────────────────────────────────
// ROUTES
// ──────────────────────────────────────────────────────────

// Health check / info
app.get('/', (req, res) => {
  res.json({
    name: 'ClawDice',
    version: '0.1.0',
    tagline: 'Provably fair Lightning dice for OpenClaw agents 🦞🎲⚡',
    mode: config.devMode ? 'development' : 'production',
    endpoints: {
      'GET /roll': 'Play a round (L402-gated in production)',
      'GET /odds': 'Payout table for all targets',
      'GET /verify/:game_id': 'Verify any past game',
      'GET /stats': 'Aggregate house stats',
      'GET /leaderboard': 'Top players by net profit',
      'GET /recent': 'Recent game feed',
    },
    game: {
      roll_range: `0–${config.game.maxRoll}`,
      house_edge: `${config.game.houseEdge * 100}%`,
      min_bet: config.game.minBet,
      max_bet: config.game.maxBet,
      default_bet: config.game.defaultBet,
      default_target: config.game.defaultTarget,
    },
    docs: 'https://github.com/mikesats/clawdice',
  });
});

// ──────────────────────────────────────────────────────────
// 🎲 ROLL — The main game endpoint
// ──────────────────────────────────────────────────────────

app.get('/roll', async (req, res) => {
  try {
    // Parse params
    const target = parseInt(req.query.target || config.game.defaultTarget);
    const betSats = parseInt(req.query.bet || config.game.defaultBet);
    const payoutMethod = req.query.payout || 'keysend';

    // Validate target
    if (target < 1 || target > config.game.maxRoll) {
      return res.status(400).json({
        error: 'invalid_target',
        message: `Target must be between 1 and ${config.game.maxRoll}`,
        hint: 'Lower target = lower win chance = higher payout',
      });
    }

    // Validate bet
    if (betSats < config.game.minBet || betSats > config.game.maxBet) {
      return res.status(400).json({
        error: 'invalid_bet',
        message: `Bet must be between ${config.game.minBet} and ${config.game.maxBet} sats`,
      });
    }

    // Get client entropy (preimage from L402 payment, or random in dev)
    const clientEntropy = extractClientEntropy(req);
    if (!clientEntropy) {
      return res.status(402).json({
        error: 'payment_required',
        message: 'No L402 authorization found. Pay the Lightning invoice to play.',
        hint: 'Use lnget to automatically handle L402 payments',
      });
    }

    // Generate server seed and resolve the game
    const serverSeed = generateServerSeed();
    const gameResult = resolveGame({ target, betSats, serverSeed, clientEntropy });

    // Generate game ID and save
    const gameId = generateGameId();
    const playerPubkey = extractPlayerPubkey(req);

    const gameRecord = {
      id: gameId,
      ...gameResult,
      payoutMethod,
      payoutStatus: gameResult.result === 'loss' ? 'n/a' : 'pending',
      playerPubkey,
    };

    saveGame(gameRecord);

    // Send payout if winner
    let payoutInfo = null;
    if (gameResult.result === 'win' && gameResult.payoutSats > 0) {
      try {
        payoutInfo = await sendPayout({
          pubkey: playerPubkey,
          amountSats: gameResult.payoutSats,
          gameId,
        });
        gameRecord.payoutStatus = 'sent';
      } catch (err) {
        console.error(`Payout failed for game ${gameId}:`, err.message);
        gameRecord.payoutStatus = 'failed';
        payoutInfo = { error: err.message };
      }
    }

    // Response
    const winProbability = target / (config.game.maxRoll + 1);
    res.json({
      game_id: gameId,
      roll: gameResult.roll,
      target,
      result: gameResult.result,
      bet_sats: betSats,
      multiplier: gameResult.multiplier,
      win_probability: Math.round(winProbability * 10000) / 100 + '%',
      payout_sats: gameResult.payoutSats,
      payout_method: payoutMethod,
      payout_status: gameRecord.payoutStatus,
      server_seed: gameResult.serverSeed,
      server_seed_hash: gameResult.serverSeedHash,
      client_entropy: gameResult.clientEntropy,
      verify_url: `/verify/${gameId}`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Roll error:', err);
    res.status(500).json({ error: 'internal', message: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// 🔍 VERIFY — Independently verify any past game
// ──────────────────────────────────────────────────────────

app.get('/verify/:gameId', (req, res) => {
  const game = getGame(req.params.gameId);

  if (!game) {
    return res.status(404).json({
      error: 'not_found',
      message: `Game ${req.params.gameId} not found`,
    });
  }

  const verification = verifyGame({
    serverSeed: game.server_seed,
    serverSeedHash: game.server_seed_hash,
    clientEntropy: game.client_entropy,
    roll: game.roll,
    target: game.target,
  });

  res.json({
    game_id: req.params.gameId,
    ...verification,
    bet_sats: game.bet_sats,
    payout_sats: game.payout_sats,
    multiplier: game.multiplier,
    created_at: game.created_at,
    how_to_verify: {
      step_1: 'Confirm SHA256(server_seed) === server_seed_hash',
      step_2: 'Compute HMAC-SHA256(server_seed, client_entropy)',
      step_3: 'Take first 2 bytes as uint16 big-endian → roll',
      step_4: 'roll < target → win, roll >= target → loss',
    },
  });
});

// ──────────────────────────────────────────────────────────
// 📊 ODDS — Payout table
// ──────────────────────────────────────────────────────────

app.get('/odds', (req, res) => {
  const targets = [1000, 4096, 8192, 16384, 32768, 49152, 56000, 60000, 64000];
  const table = targets.map((target) => {
    const winProbability = target / (config.game.maxRoll + 1);
    const multiplier = getMultiplier(target);
    return {
      target,
      win_probability: Math.round(winProbability * 10000) / 100 + '%',
      multiplier: Math.round(multiplier * 1000) / 1000,
      example_bet_100: Math.floor(100 * multiplier),
    };
  });

  res.json({
    house_edge: config.game.houseEdge * 100 + '%',
    roll_range: `0–${config.game.maxRoll}`,
    rule: 'You win if roll < target',
    payout_table: table,
  });
});

// ──────────────────────────────────────────────────────────
// 📈 STATS — Aggregate stats
// ──────────────────────────────────────────────────────────

app.get('/stats', (req, res) => {
  res.json({
    name: 'ClawDice',
    ...getStats(),
  });
});

// ──────────────────────────────────────────────────────────
// 🏆 LEADERBOARD — Top players by net profit
// ──────────────────────────────────────────────────────────

app.get('/leaderboard', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20'), 100);
  res.json({
    leaderboard: getLeaderboard(limit),
  });
});

// ──────────────────────────────────────────────────────────
// 📡 RECENT — Live game feed
// ──────────────────────────────────────────────────────────

app.get('/recent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20'), 100);
  res.json({
    games: getRecentGames(limit),
  });
});

// ──────────────────────────────────────────────────────────
// 🚀 START
// ──────────────────────────────────────────────────────────

async function start() {
  await initDb();

  app.listen(config.port, config.host, () => {
    console.log('');
    console.log('  🦞🎲⚡ ClawDice is live!');
    console.log('');
    console.log(`  → http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  → Mode: ${config.devMode ? 'DEVELOPMENT (no real payments)' : 'PRODUCTION'}`);
    console.log(`  → House edge: ${config.game.houseEdge * 100}%`);
    console.log(`  → Bet range: ${config.game.minBet}–${config.game.maxBet} sats`);
    console.log('');
    console.log('  Endpoints:');
    console.log('    GET /          → info & docs');
    console.log('    GET /roll      → play a round');
    console.log('    GET /odds      → payout table');
    console.log('    GET /verify/:id → verify a game');
    console.log('    GET /stats     → aggregate stats');
    console.log('    GET /leaderboard → top players');
    console.log('    GET /recent    → live game feed');
    console.log('');
  });
}

start().catch(console.error);
