import initSqlJs from 'sql.js';
import fs from 'fs';
import crypto from 'crypto';
import config from './config.js';

let db;

export async function initDb() {
  const SQL = await initSqlJs();

  // Load existing db file if it exists
  let buffer = null;
  try {
    if (fs.existsSync(config.db.path)) {
      buffer = fs.readFileSync(config.db.path);
    }
  } catch (e) {
    // Fresh start
  }

  db = buffer ? new SQL.Database(buffer) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      roll INTEGER NOT NULL,
      target INTEGER NOT NULL,
      result TEXT NOT NULL,
      bet_sats INTEGER NOT NULL,
      multiplier REAL NOT NULL,
      payout_sats INTEGER NOT NULL,
      payout_method TEXT DEFAULT 'keysend',
      payout_status TEXT DEFAULT 'pending',
      server_seed TEXT NOT NULL,
      server_seed_hash TEXT NOT NULL,
      client_entropy TEXT NOT NULL,
      player_pubkey TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bankroll_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      amount_sats INTEGER NOT NULL,
      balance_sats INTEGER NOT NULL,
      game_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_games_player ON games(player_pubkey)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_games_created ON games(created_at)`);

  return db;
}

// Persist db to disk
export function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(config.db.path, Buffer.from(data));
}

// Generate a short game ID
export function generateGameId() {
  return 'g_' + crypto.randomBytes(4).toString('hex');
}

// Save a game record
export function saveGame(game) {
  db.run(
    `INSERT INTO games (id, roll, target, result, bet_sats, multiplier, payout_sats,
      payout_method, payout_status, server_seed, server_seed_hash, client_entropy, player_pubkey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      game.id,
      game.roll,
      game.target,
      game.result,
      game.betSats,
      game.multiplier,
      game.payoutSats,
      game.payoutMethod || 'keysend',
      game.payoutStatus || (game.result === 'loss' ? 'n/a' : 'pending'),
      game.serverSeed,
      game.serverSeedHash,
      game.clientEntropy,
      game.playerPubkey || null,
    ]
  );
  saveDb();
}

// Get a game by ID
export function getGame(gameId) {
  const stmt = db.prepare('SELECT * FROM games WHERE id = ?');
  stmt.bind([gameId]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

// Get aggregate stats
export function getStats() {
  const total = db.exec(`
    SELECT
      COUNT(*) as total_games,
      COALESCE(SUM(bet_sats), 0) as total_wagered,
      COALESCE(SUM(payout_sats), 0) as total_paid_out,
      COUNT(DISTINCT player_pubkey) as unique_players,
      COALESCE(MAX(payout_sats), 0) as biggest_win
    FROM games
  `);

  const last24h = db.exec(`
    SELECT
      COUNT(*) as games,
      COALESCE(SUM(bet_sats), 0) as volume
    FROM games
    WHERE created_at > datetime('now', '-1 day')
  `);

  const t = total[0]?.values[0] || [0, 0, 0, 0, 0];
  const d = last24h[0]?.values[0] || [0, 0];

  return {
    total_games: t[0],
    total_wagered_sats: t[1],
    total_paid_out_sats: t[2],
    house_profit_sats: t[1] - t[2],
    unique_players: t[3],
    biggest_win_sats: t[4],
    last_24h: {
      games: d[0],
      volume_sats: d[1],
    },
  };
}

// Get leaderboard — top players by net profit
export function getLeaderboard(limit = 20) {
  const results = db.exec(`
    SELECT
      player_pubkey,
      COUNT(*) as games,
      SUM(bet_sats) as total_wagered,
      SUM(payout_sats) as total_won,
      SUM(payout_sats) - SUM(bet_sats) as net_profit,
      MAX(payout_sats) as biggest_win
    FROM games
    WHERE player_pubkey IS NOT NULL
    GROUP BY player_pubkey
    ORDER BY net_profit DESC
    LIMIT ?
  `, [limit]);

  if (!results[0]) return [];

  const columns = results[0].columns;
  return results[0].values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return obj;
  });
}

// Get recent games (for live feed)
export function getRecentGames(limit = 20) {
  const results = db.exec(`
    SELECT id, roll, target, result, bet_sats, multiplier, payout_sats,
           player_pubkey, created_at
    FROM games
    ORDER BY created_at DESC
    LIMIT ?
  `, [limit]);

  if (!results[0]) return [];

  const columns = results[0].columns;
  return results[0].values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => (obj[col] = row[i]));
    return obj;
  });
}
