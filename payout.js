import config from './config.js';

/**
 * Send a Lightning keysend payout to a winner.
 *
 * Production: connects to LND via gRPC and sends a keysend payment.
 * Development: logs the payout and returns a stub response.
 */
export async function sendPayout({ pubkey, amountSats, gameId }) {
  if (config.devMode) {
    console.log(`  [DEV] Payout: ${amountSats} sats → ${pubkey || 'unknown'} (game ${gameId})`);
    return {
      status: 'sent',
      amountSats,
      pubkey,
      gameId,
      dev: true,
    };
  }

  // TODO: Production LND keysend implementation
  // 1. Read macaroon from config.lnd.macaroonPath
  // 2. Read TLS cert from config.lnd.tlsCertPath
  // 3. Connect to LND gRPC at config.lnd.host
  // 4. Send keysend payment:
  //    - dest: pubkey
  //    - amt: amountSats
  //    - custom records: { 7629168: gameId } (keysend preimage record)
  // 5. Return payment result

  throw new Error('Production LND payouts not yet implemented. Set NODE_ENV=development to use stub payouts.');
}
