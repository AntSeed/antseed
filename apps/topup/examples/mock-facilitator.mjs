// Local stand-in for the Meridian facilitator, for the SETUP.md sandbox.
//
// The real facilitator pulls the payer's USDC via EIP-3009
// transferWithAuthorization and pays the recipient net of fees. This mock
// skips the pull (MockUSDC is mintable by anyone) and just mints the net
// amount to `extra.creditedRecipient`, so the gateway sees exactly what it
// would see on Base: a settlement tx whose Transfer logs credit the relayer
// with the gross amount minus a facilitator fee.
//
// Never use this outside a throwaway local chain.
import http from 'node:http';
import { Contract, JsonRpcProvider, NonceManager, Wallet } from 'ethers';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const USDC = process.env.USDC_ADDRESS ?? '0x5FbDB2315678afecb367f032d93F642f64180aa3';
// anvil account #5 — unused by the deploy script, so its nonce stays clean
const KEY = process.env.FACILITATOR_KEY ?? '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
const FEE_BPS = BigInt(process.env.FEE_BPS ?? '200'); // 2%, mimics platform/treasury fees
const PORT = Number(process.env.PORT ?? '9490');

const provider = new JsonRpcProvider(RPC);
const wallet = new NonceManager(new Wallet(KEY, provider));
const usdc = new Contract(USDC, ['function mint(address to, uint256 amount) external'], wallet);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/settle') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    try {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer pk_')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, errorReason: 'unauthorized', transaction: '' }));
        return;
      }
      const body = JSON.parse(raw);
      const value = BigInt(body.paymentPayload.payload.authorization.value);
      const recipient = body.paymentRequirements.extra.creditedRecipient;
      const net = value - (value * FEE_BPS) / 10_000n;
      const receipt = await (await usdc.mint(recipient, net)).wait();
      console.log(`[mock-facilitator] settled ${value} -> ${net} to ${recipient} (tx ${receipt.hash})`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, transaction: receipt.hash, network: body.paymentPayload.network }));
    } catch (err) {
      console.error('[mock-facilitator] error:', err instanceof Error ? err.message : err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, errorReason: 'unexpected_settle_error', transaction: '' }));
    }
  });
});

server.listen(PORT, () => console.log(`[mock-facilitator] listening on :${PORT}`));
