import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import { parseRequestLink } from './request-link.js';
import { buildSignedMessage } from './message.js';
import {
  signConnectResponse,
  verifyConnectResponse,
  resolveScopeValues,
  ConnectResponseError,
} from './response.js';
import { decodeResponseFragment } from './fragment.js';
import type { ConnectRequest } from './types.js';

// Anvil account #1: deterministic for golden tests.
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDRESS = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const CHALLENGE = 'kJ8s9fK2mNpQrStUvWxYz0123456789AbCdEfGhIjKl';

function makeRequest(): ConnectRequest {
  const qs = new URLSearchParams({
    version: '1',
    redirect: 'https://app.example/connect/cb',
    scopes: 'address',
    challenge: CHALLENGE,
  }).toString();
  return parseRequestLink(`antseed://connect?${qs}`);
}

describe('buildSignedMessage', () => {
  it('produces the exact signed-message bytes', () => {
    const req = makeRequest();
    const msg = buildSignedMessage(req, { address: ADDRESS });
    expect(msg).toBe(
      [
        'AntSeed Connect',
        'version: 1',
        'redirect: https://app.example/connect/cb',
        `challenge: ${CHALLENGE}`,
        'scopes: address',
        `address: ${ADDRESS}`,
      ].join('\n'),
    );
    expect(msg.endsWith('\n')).toBe(false);
  });
});

describe('signConnectResponse / verifyConnectResponse', () => {
  const wallet = new Wallet(PRIVATE_KEY);

  it('resolves the address scope value from the account address', () => {
    const req = makeRequest();
    expect(resolveScopeValues(req, wallet)).toEqual({ address: ADDRESS });
  });

  it('signs and round-trips through verify, recovering the signer', async () => {
    const req = makeRequest();
    const values = resolveScopeValues(req, wallet);
    const { response, fragmentUrl } = await signConnectResponse(wallet, req, values);

    expect(response.kind).toBe('antseed.connect.response');
    expect(response.signatureScheme).toBe('eip191-personal-sign');
    expect(response.signature).toMatch(/^[0-9a-f]{130}$/);
    expect(response.values).toEqual({ address: ADDRESS });

    const recovered = verifyConnectResponse(response, req);
    expect(recovered).toBe(ADDRESS);

    expect(fragmentUrl.startsWith('https://app.example/connect/cb#result=')).toBe(true);
    const encoded = fragmentUrl.split('#result=')[1]!;
    expect(decodeResponseFragment(encoded)).toEqual(response);
  });

  it('rejects an address value that is not the signer', async () => {
    const req = makeRequest();
    await expect(
      signConnectResponse(wallet, req, { address: '0x' + '11'.repeat(20) }),
    ).rejects.toThrow(ConnectResponseError);
  });

  it('verify rejects a tampered value', async () => {
    const req = makeRequest();
    const values = resolveScopeValues(req, wallet);
    const { response } = await signConnectResponse(wallet, req, values);
    const tampered = { ...response, values: { address: '0x' + '22'.repeat(20) } };
    expect(() => verifyConnectResponse(tampered, req)).toThrow(ConnectResponseError);
  });

  it('verify rejects a challenge mismatch', async () => {
    const req = makeRequest();
    const values = resolveScopeValues(req, wallet);
    const { response } = await signConnectResponse(wallet, req, values);
    const otherReq = { ...req, challenge: 'different-challenge-value-000000000000000000' };
    expect(() => verifyConnectResponse(response, otherReq)).toThrow(/challenge/);
  });

  it('verify rejects a malformed signature with a ConnectResponseError', async () => {
    const req = makeRequest();
    const values = resolveScopeValues(req, wallet);
    const { response } = await signConnectResponse(wallet, req, values);
    const broken = { ...response, signature: 'zz' };
    expect(() => verifyConnectResponse(broken, req)).toThrow(ConnectResponseError);
  });

  it('verify rejects an unrequested scope in the response', async () => {
    const req = makeRequest();
    const values = resolveScopeValues(req, wallet);
    const { response } = await signConnectResponse(wallet, req, values);
    const extra = { ...response, values: { ...response.values, secrets: 'x' } };
    expect(() => verifyConnectResponse(extra, req)).toThrow(/unrequested scope/);
  });
});

describe('auto-deposit scope', () => {
  const wallet = new Wallet(PRIVATE_KEY);
  const account = {
    address: wallet.address,
    autoDeposit: { enabled: true, delegated: false },
    signMessage: (message: string) => wallet.signMessage(message),
  };

  function makeRequestWithAutoDeposit(): ConnectRequest {
    const qs = new URLSearchParams({
      version: '1',
      redirect: 'https://app.example/connect/cb',
      scopes: 'address,auto-deposit',
      challenge: CHALLENGE,
    }).toString();
    return parseRequestLink(`antseed://connect?${qs}`);
  }

  it('resolves to deterministic JSON with fixed key order', () => {
    const req = makeRequestWithAutoDeposit();
    const values = resolveScopeValues(req, account);
    expect(values['auto-deposit']).toBe('{"enabled":true,"delegated":false}');
  });

  it('signs and round-trips, parsing back to the input state', async () => {
    const req = makeRequestWithAutoDeposit();
    const values = resolveScopeValues(req, account);
    const { response } = await signConnectResponse(account, req, values);

    const recovered = verifyConnectResponse(response, req);
    expect(recovered).toBe(ADDRESS);
    expect(JSON.parse(response.values['auto-deposit']!)).toEqual({
      enabled: true,
      delegated: false,
    });
  });

  it('defaults to a disabled state when the account has no auto-deposit data', () => {
    const req = makeRequestWithAutoDeposit();
    const bare = {
      address: wallet.address,
      signMessage: (message: string) => wallet.signMessage(message),
    };
    const values = resolveScopeValues(req, bare);
    expect(values['auto-deposit']).toBe('{"enabled":false,"delegated":false}');
  });
});
