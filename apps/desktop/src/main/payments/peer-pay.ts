import { asRecord } from '../utils.js';

const PEER_PAY_REQUEST_TIMEOUT_MS = 8000;

type CreatePeerPayCheckoutInput = {
  readonly endpoint: string;
  readonly address: string;
  readonly amount: string;
};

function parseSecureUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(`${label} URL must be https`);
  }
  return url;
}

export async function createPeerPayCheckout(
  input: CreatePeerPayCheckoutInput,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const endpoint = parseSecureUrl(input.endpoint, 'Peer Pay endpoint');
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: input.address,
      amount: input.amount,
    }),
    signal: AbortSignal.timeout(PEER_PAY_REQUEST_TIMEOUT_MS),
  });
  const body = asRecord(await response.json());
  if (!response.ok) {
    const message = asRecord(body.error).message;
    throw new Error(typeof message === 'string' ? message : `Peer Pay checkout failed with status ${response.status}`);
  }

  const checkoutUrlValue = body.checkoutUrl;
  if (typeof checkoutUrlValue !== 'string' || checkoutUrlValue === '') {
    throw new Error('Peer Pay checkout response is missing checkoutUrl');
  }
  const checkoutUrl = parseSecureUrl(checkoutUrlValue, 'Peer Pay checkout');
  return checkoutUrl.toString();
}
