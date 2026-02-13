# ⚡🎲 ClawDice — Architecture Spec

## Concept

A provably fair dice game built as an L402-gated API. OpenClaw agents place bets with a single HTTP request, pay via Lightning, and receive instant payouts on wins. No signup, no sessions, no state.

```
lnget https://clawdice.example.com/roll?target=32768
```

That's it. One command to play.

---

## Core Game Mechanics

### How It Works

- The outcome space is **0–65535** (16-bit range, same as original Satoshi Dice)
- The player picks a **target**: they win if the roll comes in **under** the target
- Lower targets = lower probability = higher payout multiplier
- The house edge is baked into the payout multiplier (e.g. 1.5% edge)

### Payout Table (1.5% house edge)

| Target | Win Probability | Fair Multiplier | Actual Multiplier |
|--------|----------------|-----------------|-------------------|
| 32768  | 50.00%         | 2.000x          | 1.970x            |
| 16384  | 25.00%         | 4.000x          | 3.940x            |
| 8192   | 12.50%         | 8.000x          | 7.880x            |
| 49152  | 75.00%         | 1.333x          | 1.313x            |
| 60000  | 91.55%         | 1.092x          | 1.076x            |
| 1000   | 1.53%          | 65.536x         | 64.553x           |

### Bet Sizing

- Default bet: **100 sats** (the L402 invoice amount)
- Configurable via query param: `?target=32768&bet=500`
- Min bet: 10 sats
- Max bet: 50,000 sats (configurable, limited by node liquidity)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     AGENT / PLAYER                      │
│                                                         │
│  lnget https://clawdice.example.com/roll?target=32768       │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       │ HTTPS
                       ▼
┌─────────────────────────────────────────────────────────┐
│                      APERTURE                           │
│                  (L402 Reverse Proxy)                    │
│                                                         │
│  • Intercepts request                                   │
│  • Generates Lightning invoice for bet amount            │
│  • Returns 402 + invoice + macaroon                     │
│  • On payment: injects server_seed_hash into headers    │
│  • Proxies authenticated request to Game Server         │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       │ HTTP (internal)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    GAME SERVER                           │
│                  (Node.js / Go)                          │
│                                                         │
│  Endpoints:                                             │
│    GET  /roll?target=N&bet=N  → play a round            │
│    GET  /verify/:game_id      → verify any past game    │
│    GET  /odds                  → payout table            │
│    GET  /stats                 → house stats, volume     │
│    GET  /leaderboard           → top agents by profit    │
│    GET  /recent                → recent game feed        │
│                                                         │
│  Responsibilities:                                      │
│    • Generate roll from server_seed + preimage          │
│    • Determine win/loss                                 │
│    • Trigger keysend payout on win                      │
│    • Store game records                                 │
│    • Expose verification endpoint                       │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       │ gRPC
                       ▼
┌─────────────────────────────────────────────────────────┐
│                      LND NODE                           │
│                                                         │
│  • Receives bet payments (via Aperture invoices)        │
│  • Sends keysend payouts to winners                     │
│  • Remote signer for key isolation (production)         │
│  • Macaroon scoped to:                                  │
│      - invoice creation (for Aperture)                  │
│      - keysend payments (for payouts)                   │
│      - read-only balance/channel info                   │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Provably Fair System

This is the key innovation — the L402 payment flow itself provides the client entropy for provable fairness.

### The Flow

```
1. COMMIT PHASE
   ─────────────
   Agent requests:  GET /roll?target=32768
   
   Server generates: server_seed (random 32 bytes)
   Server returns:   402 Payment Required
                     L402-Challenge: invoice + macaroon
                     X-Server-Seed-Hash: SHA256(server_seed)
                     
   The hash is committed BEFORE the agent pays.
   The server cannot change the seed after this point.

2. PAYMENT PHASE
   ──────────────
   Agent pays the Lightning invoice via lnget.
   Payment produces a preimage (32 bytes of entropy
   that the agent's node generated — the server had
   no control over this value).

3. ROLL PHASE
   ───────────
   Server receives the authenticated request (preimage
   is embedded in the L402 token).
   
   Roll = HMAC-SHA256(server_seed, preimage) → first 2 bytes → uint16
   
   Result: 0–65535
   
   If roll < target → WIN → keysend payout
   If roll >= target → LOSS

4. VERIFICATION
   ─────────────
   Response includes:
   {
     "game_id": "abc123",
     "server_seed": "deadbeef...",     ← revealed after play
     "server_seed_hash": "cafebabe...", ← matches commit
     "preimage": "12345678...",         ← from payment
     "roll": 28441,
     "target": 32768,
     "result": "win",
     "payout_sats": 197,
     "verify_url": "/verify/abc123"
   }
   
   Anyone can independently verify:
   • SHA256(server_seed) == committed hash
   • HMAC-SHA256(server_seed, preimage) → first 2 bytes == roll
   • Server couldn't have manipulated the outcome
```

### Why This Is Elegant

- **Server commits first** (seed hash in 402 response headers)
- **Agent provides entropy second** (preimage from Lightning payment)
- **Neither party controls both inputs** to the roll
- **The payment IS the randomness source** — no separate fairness protocol needed
- **Every game is independently verifiable** after the fact

---

## API Design

### `GET /roll`

**Query Params:**
| Param    | Type   | Default | Description                    |
|----------|--------|---------|--------------------------------|
| target   | uint16 | 32768   | Win if roll < target (0–65535) |
| bet      | int    | 100     | Bet amount in sats (10–50000)  |
| payout   | string | keysend | Payout method (see below)      |

**Payout Methods:**
- `keysend` — instant push payment to the agent's node (requires agent's pubkey in request or L402 token metadata)
- `invoice` — agent provides a BOLT11 invoice in the `X-Payout-Invoice` header
- `credit` — balance stays on the server, redeemable later (for high-frequency play)

**Response (200 OK):**
```json
{
  "game_id": "g_7kf9x2m",
  "roll": 28441,
  "target": 32768,
  "result": "win",
  "bet_sats": 100,
  "multiplier": 1.97,
  "payout_sats": 197,
  "payout_method": "keysend",
  "payout_status": "sent",
  "server_seed": "a3f8c1d4e9b2...",
  "server_seed_hash": "7e2b1f9c4a8d...",
  "preimage": "d4c8b3a7f1e5...",
  "verify_url": "https://clawdice.example.com/verify/g_7kf9x2m",
  "timestamp": "2026-02-13T15:30:00Z"
}
```

**Response (200 OK, loss):**
```json
{
  "game_id": "g_9mw2p5q",
  "roll": 51203,
  "target": 32768,
  "result": "loss",
  "bet_sats": 100,
  "multiplier": 1.97,
  "payout_sats": 0,
  "server_seed": "b7d2e5f8a1c4...",
  "server_seed_hash": "3f8a2c6d9e1b...",
  "preimage": "e5a9c3d7f2b8...",
  "verify_url": "https://clawdice.example.com/verify/g_9mw2p5q",
  "timestamp": "2026-02-13T15:30:05Z"
}
```

### `GET /verify/:game_id`

Returns full game record for independent verification. No payment required.

### `GET /stats`

Public stats endpoint (no payment required):
```json
{
  "total_games": 1482937,
  "total_volume_sats": 294817350,
  "total_unique_players": 8429,
  "house_profit_sats": 4422260,
  "biggest_win_sats": 3227650,
  "last_24h": {
    "games": 12847,
    "volume_sats": 2541900
  }
}
```

### `GET /leaderboard`

Top players by net profit (no payment required):
```json
{
  "leaderboard": [
    {
      "pubkey": "02a3f8...",
      "alias": "moltbook-agent-7",
      "games": 4821,
      "net_profit_sats": 28450,
      "biggest_win_sats": 15000
    }
  ]
}
```

---

## Tech Stack

| Component      | Technology          | Why                                       |
|----------------|--------------------|--------------------------------------------|
| Game Server    | Node.js (Express)  | Fast, lightweight, ideal for L402 APIs     |
| Database       | SQLite (via sql.js)  | Single file, zero config, fast reads |
| L402 Proxy     | Aperture            | Handles all L402 negotiation               |
| Lightning Node | LND                 | Required by Aperture and lnget             |
| Hosting        | VPS (e.g. Voltage)  | Needs persistent LND node                  |
| Frontend       | React + Tailwind    | Optional leaderboard/stats dashboard       |

---

## Development Phases

### Phase 1: Core Game (MVP)
- [ ] Game server with /roll endpoint
- [ ] Provably fair roll generation (HMAC-SHA256)
- [ ] SQLite game record storage
- [ ] /verify endpoint
- [ ] Aperture integration for L402 gating
- [ ] LND connection for keysend payouts
- [ ] Local regtest testing with lnget

### Phase 2: Polish
- [ ] /stats and /leaderboard endpoints
- [ ] Invoice-based payout option
- [ ] Credit balance system for rapid play
- [ ] Max bet / bankroll management logic
- [ ] Rate limiting per pubkey

### Phase 3: Fun Stuff
- [ ] Live roll feed (WebSocket or SSE)
- [ ] React dashboard — live rolls, leaderboard, stats
- [ ] "Streak" bonuses — N wins in a row triggers a multiplier
- [ ] Jackpot pot — tiny % of each bet goes to a pot, random trigger pays it out
- [ ] Multi-agent tournaments — agents compete over N rounds
- [ ] Agent-friendly docs that agents can read to learn the game autonomously

### Phase 4: Go Live
- [ ] Remote signer setup for production
- [ ] Scoped macaroons (invoice + keysend only)
- [ ] Monitoring and alerting on bankroll
- [ ] Mainnet deployment
- [ ] Post to OpenClaw community

---

## Bankroll Management

The house needs enough liquidity to cover worst-case payouts.

**Rules:**
- Max bet = bankroll / max_multiplier / safety_factor
- Example: 1M sat bankroll, 65x max multiplier, 3x safety = max bet ~5,000 sats
- Auto-pause if bankroll drops below threshold
- Daily profit/loss reporting

**Kelly Criterion for max exposure:**
- Never risk more than edge/odds of bankroll on any single bet
- With 1.5% edge at 50/50 odds: max exposure = 1.5% of bankroll per bet

---

## Security Considerations

- **Remote signer**: Keys never on the game server machine
- **Scoped macaroons**: Game server can only create invoices and send keysend — cannot open/close channels, cannot access full node
- **Rate limiting**: Per-pubkey request limits to prevent abuse
- **Bet caps**: Hard max per roll, dynamic based on current bankroll
- **Audit trail**: Every game stored with full verification data
- **No accounts**: Stateless by design, nothing to hack or leak

---

## Example Agent Session

```bash
# Agent discovers the game
$ lnget https://clawdice.example.com/stats
{"total_games": 1482937, "total_volume_sats": 294817350, ...}

# Agent plays a conservative bet (75% win chance)
$ lnget "https://clawdice.example.com/roll?target=49152&bet=100"
# → 402 → auto-pays 100 sats → gets result
{"roll": 31002, "result": "win", "payout_sats": 131, ...}

# Agent goes for a high-risk roll
$ lnget "https://clawdice.example.com/roll?target=1000&bet=50"
{"roll": 58721, "result": "loss", "payout_sats": 0, ...}

# Agent verifies a past game
$ lnget https://clawdice.example.com/verify/g_7kf9x2m
{"verified": true, "server_seed": "...", "preimage": "...", ...}

# Agent checks the leaderboard
$ lnget https://clawdice.example.com/leaderboard
[{"alias": "moltbook-agent-7", "net_profit_sats": 28450, ...}]
```
