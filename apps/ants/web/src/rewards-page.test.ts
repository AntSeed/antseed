import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RewardsView } from '../../src/api-types';
import { AppContext, type AppValue } from './app-context';
import type { ActionButtonProps } from './components/Confirm';
import { RewardsPage } from './pages/Rewards';

const state = vi.hoisted(() => ({ rewards: null as RewardsView | null, actions: [] as ActionButtonProps[] }));
vi.mock('./data', () => ({ usePageData: (key: string | null) => ({ data: key === 'rewards' ? state.rewards : null, error: null, loading: false, refresh: () => {} }) }));
vi.mock('./wallet', () => ({ BuyerWalletAction: () => null }));
vi.mock('./components/Confirm', () => ({ ActionButton: (props: ActionButtonProps) => {
  state.actions.push(props);
  return createElement('button', { disabled: props.disabled }, props.label);
} }));

const wallet = '0x0000000000000000000000000000000000000001';
const buyer = '0x0000000000000000000000000000000000000002';
const pool = '0x0000000000000000000000000000000000000003';
const ants = (amount: number) => (BigInt(amount) * 10n ** 18n).toString();
const context = {
  config: { address: wallet, buyerAddress: buyer, chainId: 'base-mainnet', evmChainId: 8453, readOnly: false },
  overview: { epoch: { current: 23, genesis: 1775728461, epochDuration: 604800 }, wallet: { canTransfer: false, eth: ants(1) } },
} as AppValue;

function render() {
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, createElement(RewardsPage)));
}

function summary(action: ActionButtonProps) {
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, createElement('div', null, action.summary.map(([label, value]) => createElement('div', { key: label }, label, value)))));
}

function action(title: string) {
  const found = state.actions.find((entry) => entry.title === title);
  expect(found).toBeDefined();
  return found!;
}

beforeEach(() => {
  state.actions = [];
  state.rewards = {
    scope: 'all', currentEpoch: 23, firstRewardedEpoch: 22, total: ants(2200),
    staker: { total: ants(100), positions: [] },
    sellerUsage: { total: ants(150), agentId: 42, epochs: [], claimable: true },
    buyerUsage: { total: ants(250), epochs: [], operator: wallet, recipient: wallet, claimable: true },
    legacy: { seller: ants(600), buyer: ants(1000), contract: pool, buyerClaimable: true, sellerPayout: { destination: 'locked', recipient: pool } },
    locked: { locked: ants(1000), claimable: ants(100), policy: pool, pool },
  };
});

describe('reward row actions and confirmations', () => {
  it.each([true, false])('uses short reward definitions rather than eligibility messages (eligible: %s)', (eligible) => {
    if (!eligible) {
      state.rewards!.buyerUsage.total = '0';
      state.rewards!.buyerUsage.claimable = false;
      state.rewards!.sellerUsage.claimable = false;
      state.rewards!.legacy.sellerPayout = { destination: 'unknown', recipient: null };
      state.rewards!.locked.policy = null;
      state.rewards!.locked.claimable = '0';
    }
    const html = render();
    const descriptions = [...html.matchAll(/<div class="bucket-note">([^<]*)<\/div>/g)].map((match) => match[1]);
    expect(descriptions).toEqual([
      'Earned from using AI services.',
      'Earned from using AI services under the previous rewards system.',
      'Earned from staking ANTS in seller pools.',
      'Earned from providing AI services.',
      'Earned from providing AI services under the previous rewards system.',
      'Past seller rewards held in the locked pool.',
    ]);
  });
  it.each([
    { canTransfer: true, readOnly: false, failedRead: false, walletRoute: true },
    { canTransfer: false, readOnly: false, failedRead: false, walletRoute: false },
    { canTransfer: true, readOnly: true, failedRead: false, walletRoute: false },
    { canTransfer: true, readOnly: false, failedRead: true, walletRoute: false },
  ])('retains permission-aware legacy guidance in confirmations: %j', ({ canTransfer, readOnly, failedRead, walletRoute }) => {
    const oldOverview = context.overview;
    const oldConfig = context.config;
    const oldError = context.overviewError;
    context.overview = { ...context.overview!, wallet: { ...context.overview!.wallet, canTransfer } };
    context.config = { ...context.config, readOnly };
    context.overviewError = failedRead ? 'RPC unavailable' : null;
    try {
      render();
      for (const title of ['Claim legacy buyer rewards', 'Claim legacy seller rewards', 'Withdraw released seller rewards']) {
        const detail = summary(action(title));
        expect(detail).toContain('Legacy rewards have no direct staking function.');
        expect(detail.includes('href="#/stake"')).toBe(walletRoute);
        if (walletRoute) expect(detail).toContain('Claiming and staking are separate transactions.');
        if (!canTransfer) expect(detail).toContain('Claiming rewards will not remove that restriction.');
      }
    } finally {
      context.overview = oldOverview;
      context.config = oldConfig;
      context.overviewError = oldError;
    }
  });
  it('separates current and legacy buyer claims and shows their individual amounts', () => {
    const html = render();
    expect(html).toContain('Current buyer rewards');
    expect(html).toContain('Legacy buyer rewards');
    expect(html).toContain('Seller &amp; staking rewards');
    expect(html).not.toContain('Wallet rewards');
    expect(action('Claim current buyer rewards').body).toEqual({ buckets: ['buyer'], scope: 'buyer' });
    expect(action('Claim legacy buyer rewards').body).toEqual({ buckets: ['legacy'], scope: 'buyer' });
    expect(summary(action('Claim current buyer rewards'))).toContain('250 ANTS');
    expect(summary(action('Claim legacy buyer rewards'))).toContain('1,000 ANTS');
    for (const title of ['Claim current buyer rewards', 'Claim legacy buyer rewards']) {
      expect(summary(action(title))).toContain(wallet);
      expect(summary(action(title))).toContain(buyer);
      expect(summary(action(title))).toContain('No staking position is created');
    }
  });
  it('uses consistent staking labels without offering legacy staking', () => {
    render();
    const staking = state.actions.filter((entry) => entry.path !== '/api/rewards/claim');
    expect(staking).toHaveLength(4);
    for (const entry of staking) expect(entry.label).toBe('Stake rewards');
    expect(action('Stake current buyer rewards').body).toMatchObject({ side: 'buyer' });
    expect(action('Stake current seller rewards').body).toMatchObject({ side: 'seller' });
    expect(action('Stake seller & staking rewards').body).toMatchObject({ includeBuyer: false });
    expect(state.actions.some((entry) => entry.title?.includes('Stake legacy'))).toBe(false);
  });
  it('disables buyer actions when the connected wallet is not authorized', () => {
    state.rewards!.buyerUsage.operator = buyer;
    state.rewards!.buyerUsage.claimable = false;
    state.rewards!.legacy.buyerClaimable = false;
    render();
    expect(action('Claim current buyer rewards').disabled).toBe(true);
    expect(action('Claim legacy buyer rewards').disabled).toBe(true);
    expect(state.actions.some((entry) => entry.title === 'Stake current buyer rewards')).toBe(false);
  });
  it.each(['wallet', 'locked', 'unknown', 'missing'] as const)('shows the verified legacy seller destination: %s', (destination) => {
    state.rewards!.legacy.sellerPayout = destination === 'missing' ? undefined : { destination, recipient: destination === 'wallet' ? wallet : destination === 'locked' ? pool : null };
    render();
    const claim = action('Claim legacy seller rewards');
    if (destination === 'unknown' || destination === 'missing') {
      expect(claim.disabled).toBe(true);
      expect(claim.label).toBe('Claim unavailable');
      expect(summary(claim)).toContain('Not verified');
    } else {
      expect(claim.disabled).toBe(false);
      expect(claim.label).toBe(destination === 'locked' ? 'Claim to locked pool' : 'Claim to wallet');
      expect(claim.body).toEqual({ buckets: ['legacy'], scope: 'wallet', expectedLegacySellerRecipient: destination === 'locked' ? pool : wallet });
      expect(summary(claim)).toContain(destination === 'locked' ? 'Rewards remain locked' : 'Paid to your wallet');
      expect(summary(claim)).toContain('No staking position is created');
    }
  });
  it('shows the withdrawable amount, recipient and remaining locked balance', () => {
    render();
    const withdraw = action('Withdraw released seller rewards');
    expect(withdraw.label).toBe('Withdraw available amount');
    expect(withdraw.body).toEqual({ buckets: ['locked'], scope: 'wallet' });
    expect(summary(withdraw)).toContain('100 ANTS');
    expect(summary(withdraw)).toContain('900 ANTS');
    expect(summary(withdraw)).toContain(wallet);
    expect(summary(withdraw)).toContain('No staking position is created');
  });
  it('disables withdrawals without a release policy', () => {
    state.rewards!.locked.policy = null;
    state.rewards!.locked.claimable = '0';
    render();
    expect(action('Withdraw released seller rewards').disabled).toBe(true);
  });
});
