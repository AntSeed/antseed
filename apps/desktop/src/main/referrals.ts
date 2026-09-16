import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { getAddress, ZeroAddress } from 'ethers';
import { ReferralsClient } from '@antseed/node';
import { ensureSecureIdentity, getSecureIdentity } from './identity.js';
import { loadCachedCryptoConfig } from './payments/credits.js';

export type ReferralConfidence = 'probable' | 'low';
export type ReferralSetupStatus = {
  state: 'none' | 'candidate' | 'declined' | 'accepted' | 'bound' | 'error';
  referrer?: string;
  confidence?: ReferralConfidence;
  error?: string;
  binding?: {
    evmChainId: number;
    referralsAddress: string;
    buyer: string;
    referrer: string;
    nonce: string;
    deadline: number;
    signature: string;
  };
};

const STATE_PATH = path.join(homedir(), '.antseed', 'referral.json');
const MATCH_URL = process.env.ANTSEED_REFERRAL_MATCH_URL ?? 'https://download.antseed.com/referral/match';
const NO_REFERRAL: ReferralSetupStatus = { state: 'none' };

function normalizeReferrer(value: string | undefined): string | null {
  try {
    return getAddress(value?.trim() ?? '');
  } catch {
    return null;
  }
}

async function readState(): Promise<ReferralSetupStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, 'utf8')) as ReferralSetupStatus;
    return parsed && typeof parsed.state === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeState(state: ReferralSetupStatus): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  const temporaryPath = `${STATE_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, STATE_PATH);
}

export async function getReferralSetupStatus(): Promise<ReferralSetupStatus> {
  const stored = await readState();
  if (stored?.state === 'declined' || stored?.state === 'bound') return stored;
  if (stored?.state === 'accepted' && (stored.binding?.deadline ?? 0) > Math.floor(Date.now() / 1000) + 60) return stored;
  if (stored?.state === 'accepted' && stored.referrer) {
    const candidate: ReferralSetupStatus = { state: 'candidate', referrer: stored.referrer, confidence: 'probable' };
    await writeState(candidate);
    return candidate;
  }
  const fallback = stored ?? NO_REFERRAL;
  try {
    const response = await fetch(MATCH_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return fallback;
    const payload = await response.json() as {
      match?: { referrer?: string; confidence?: ReferralConfidence } | null;
    };
    const referrer = normalizeReferrer(payload.match?.referrer);
    if (!referrer) return fallback;
    const candidate: ReferralSetupStatus = {
      state: 'candidate',
      referrer,
      confidence: payload.match?.confidence === 'low' ? 'low' : 'probable',
    };
    await writeState(candidate);
    return candidate;
  } catch {
    return fallback;
  }
}

export async function declineReferral(): Promise<ReferralSetupStatus> {
  const state: ReferralSetupStatus = { state: 'declined' };
  await writeState(state);
  return state;
}

export async function acceptReferral(rawReferrer: string): Promise<ReferralSetupStatus> {
  const referrer = normalizeReferrer(rawReferrer);
  if (!referrer) return { state: 'error', error: 'Invalid referrer wallet.' };
  try {
    await ensureSecureIdentity();
    const identity = getSecureIdentity();
    if (!identity) throw new Error('Buyer signer is unavailable.');
    const config = await loadCachedCryptoConfig();
    if (!config?.referralsAddress) throw new Error('Referrals are not configured for this network.');
    const buyer = identity.wallet.address;
    if (buyer.toLowerCase() === referrer.toLowerCase()) throw new Error('A wallet cannot refer itself.');

    const client = new ReferralsClient({
      rpcUrl: config.rpcUrl,
      ...(config.fallbackRpcUrls ? { fallbackRpcUrls: config.fallbackRpcUrls } : {}),
      contractAddress: config.referralsAddress,
      evmChainId: config.chainId,
    });
    const existing = await client.referrerOf(buyer);
    if (existing !== ZeroAddress) {
      const state: ReferralSetupStatus = { state: 'bound', referrer: getAddress(existing) };
      await writeState(state);
      return state;
    }

    const nonce = await client.nonce(buyer);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60);
    const binding = await client.signBinding(identity.wallet, { referrer, nonce, deadline });
    const state: ReferralSetupStatus = {
      state: 'accepted',
      referrer,
      binding: {
        evmChainId: config.chainId,
        referralsAddress: config.referralsAddress,
        buyer,
        referrer,
        nonce: nonce.toString(),
        deadline: Number(deadline),
        signature: binding.signature,
      },
    };
    await writeState(state);
    return state;
  } catch (error) {
    return { state: 'error', referrer, error: error instanceof Error ? error.message : String(error) };
  }
}
