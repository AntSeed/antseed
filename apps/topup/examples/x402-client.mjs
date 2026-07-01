// Minimal x402 client for the SETUP.md sandbox: requests a top-up, receives
// the 402 challenge, signs the EIP-3009 authorization it describes (gasless
// — the payer wallet needs no ETH), retries with X-PAYMENT, then replays the
// same payment once to demonstrate idempotency.
//
// Everything except the chain id and the payer key is taken from the 402
// challenge itself, exactly as a generic x402 client would.
import { Wallet, hexlify, randomBytes } from 'ethers';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8390';
// anvil account #2 — the payer signs off-chain only, no funds needed
const PAYER_KEY = process.env.PAYER_KEY ?? '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const EVM_CHAIN_ID = Number(process.env.EVM_CHAIN_ID ?? '31337');
const AMOUNT = process.env.AMOUNT ?? '5000000'; // 5 USDC in base units

const payer = new Wallet(PAYER_KEY);
const buyer = process.env.BUYER ?? payer.address;

async function post(body, headers = {}) {
  const res = await fetch(`${GATEWAY}/v1/topup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

// 1. Unpaid request -> 402 challenge with payment requirements
const challenge = await post({ buyer, amount: AMOUNT });
console.log(`\n=== 1. unpaid request -> HTTP ${challenge.status}`);
console.log(JSON.stringify(challenge.body, null, 2));
if (challenge.status !== 402) process.exit(1);
const requirements = challenge.body.accepts[0];

// 2. Sign the EIP-3009 TransferWithAuthorization the challenge describes
const authorization = {
  from: payer.address,
  to: requirements.payTo,
  value: BigInt(requirements.maxAmountRequired),
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + Number(requirements.maxTimeoutSeconds)),
  nonce: hexlify(randomBytes(32)),
};
const signature = await payer.signTypedData(
  {
    name: requirements.extra.name,
    version: requirements.extra.version,
    chainId: EVM_CHAIN_ID,
    verifyingContract: requirements.asset,
  },
  {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  authorization,
);
const paymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network: requirements.network,
  payload: {
    signature,
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
  },
};
const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

// 3. Retry with X-PAYMENT -> settle + deposit
const paid = await post({ buyer, amount: AMOUNT }, { 'x-payment': xPayment });
console.log(`\n=== 2. paid request -> HTTP ${paid.status}`);
console.log(JSON.stringify(paid.body, null, 2));
const settleHeader = paid.headers.get('x-payment-response');
if (settleHeader) {
  console.log('X-PAYMENT-RESPONSE:', Buffer.from(settleHeader, 'base64').toString('utf-8'));
}
if (paid.status !== 200) process.exit(1);

// 4. Replay the identical payment -> same result, nothing settled twice
const replay = await post({ buyer, amount: AMOUNT }, { 'x-payment': xPayment });
console.log(`\n=== 3. replay -> HTTP ${replay.status} (state: ${replay.body.state}, depositTx: ${replay.body.depositTx})`);
