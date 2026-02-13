# Clawdice.md

## Project Overview

ClawDice is a provably fair dice gambling game exposed as an L402-gated API for OpenClaw agents. Agents bet satoshis over Lightning Network with a single HTTP request — no signup, no sessions, no stored state.

## Tech Stack

- **Runtime**: Node.js (ES6 modules)
- **Server**: Express.js
- **Database**: SQLite via sql.js
- **Crypto**: Node.js `crypto` (HMAC-SHA256, SHA256)
- **Payments**: Lightning Network via LND + Aperture (L402 proxy)

## Project Structure

```
├── architecture.md   # System architecture & game mechanics spec
├── config.js         # Centralized configuration (game params, bankroll, LND)
├── dice.js           # Core provably-fair dice engine
├── db.js             # SQLite database operations
├── server.js         # Express.js API server (main entry point)
├── test.js           # Test suite
└── payout.js         # (NOT YET IMPLEMENTED) Lightning keysend payouts
```

## Running the Project

```bash
# Development mode (stubbed payments, random entropy)
NODE_ENV=development node server.js

# Production mode (real LND payments)
NODE_ENV=production node server.js
```

## Running Tests

```bash
node test.js
```

## Key Environment Variables

- `PORT` (default: 3000)
- `NODE_ENV` — `development` disables real payments
- `HOUSE_EDGE` (default: 0.015 / 1.5%)
- `MIN_BET` / `MAX_BET` (default: 10 / 50,000 sats)
- `INITIAL_BANKROLL` (default: 1,000,000 sats)
- `LND_HOST`, `LND_MACAROON`, `LND_TLS_CERT` — LND connection
- `DB_PATH` (default: ./clawdice.db)

## API Endpoints

- `GET /` — Server info
- `GET /roll?target=N&bet=N` — Play a round (L402-gated)
- `GET /verify/:game_id` — Verify a past game (public)
- `GET /odds` — Payout table
- `GET /stats` — Aggregate stats
- `GET /leaderboard` — Top players
- `GET /recent` — Recent games

## Game Mechanics

- Roll range: 0–65535 (16-bit). Player picks a target; wins if roll < target.
- Lower target = lower win probability = higher payout multiplier.
- Provable fairness: server commits SHA256(seed) before play; roll derived from HMAC-SHA256(serverSeed, playerEntropy). Neither party controls both inputs.

## Code Conventions

- ES6 module syntax (`import`/`export`)
- `saveDb()` called after every database write to sync SQLite to disk
- Validation happens at the API layer before game resolution
- Dev mode uses random entropy; production uses the L402 preimage as player entropy
- No package.json yet — dependencies are `express` and `sql.js`
