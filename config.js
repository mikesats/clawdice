// ClawDice Configuration
// All game parameters in one place

const config = {
  // Server
  port: parseInt(process.env.PORT || '3000'),
  host: process.env.HOST || '0.0.0.0',

  // Game mechanics
  game: {
    // Roll range: 0 to maxRoll (16-bit, same as original Satoshi Dice)
    maxRoll: 65535,

    // House edge as a decimal (1.5% = 0.015)
    houseEdge: parseFloat(process.env.HOUSE_EDGE || '0.015'),

    // Default target (50/50)
    defaultTarget: 32768,

    // Bet limits in sats
    minBet: parseInt(process.env.MIN_BET || '10'),
    maxBet: parseInt(process.env.MAX_BET || '50000'),
    defaultBet: 100,
  },

  // Bankroll management
  bankroll: {
    // Initial bankroll in sats (for tracking, actual funds are on the LND node)
    initial: parseInt(process.env.INITIAL_BANKROLL || '1000000'),

    // Pause the game if bankroll drops below this
    pauseThreshold: parseInt(process.env.PAUSE_THRESHOLD || '100000'),

    // Safety factor for max bet calculation
    // maxBet = min(configured maxBet, bankroll / maxMultiplier / safetyFactor)
    safetyFactor: 3,
  },

  // LND connection (for payouts — stubbed in dev mode)
  lnd: {
    host: process.env.LND_HOST || 'localhost:10009',
    macaroonPath: process.env.LND_MACAROON || '',
    tlsCertPath: process.env.LND_TLS_CERT || '',
  },

  // Database
  db: {
    path: process.env.DB_PATH || './clawdice.db',
  },

  // Dev mode — no real LND, no real payments
  devMode: process.env.NODE_ENV !== 'production',
};

// Derived: calculate multiplier for a given target
config.game.getMultiplier = (target) => {
  const winProbability = target / (config.game.maxRoll + 1);
  const fairMultiplier = 1 / winProbability;
  return fairMultiplier * (1 - config.game.houseEdge);
};

// Derived: calculate dynamic max bet based on current bankroll
config.game.getDynamicMaxBet = (currentBankroll) => {
  // Worst case: lowest target (1) = highest multiplier
  const highestMultiplier = config.game.getMultiplier(1);
  const bankrollLimit = Math.floor(
    currentBankroll / highestMultiplier / config.bankroll.safetyFactor
  );
  return Math.min(config.game.maxBet, bankrollLimit);
};

export default config;
