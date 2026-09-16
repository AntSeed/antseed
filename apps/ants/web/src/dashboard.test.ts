import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type AppValue } from './app-context';
import { LockSlider } from './components/LockSlider';
import { RewardsPage } from './pages/Rewards';
import { SellerPage } from './pages/Seller';
import { StakePage } from './pages/Stake';
import { StakeForm } from './components/StakeForm';
import { poolName, poolLabel, PoolsTable, PoolDrawer, sortPoolsByMetric } from './components/Pools';
import type { PoolView, PoolsView, RewardsView, SellerView } from '../../src/api-types';

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown>, keys: [] as Array<string | null> }));
vi.mock('./data', () => ({ usePageData: (key: string | null) => { state.keys.push(key); return { data: key ? state.data[key] ?? null : null, error: null, loading: false, refresh: () => {} }; } }));
vi.mock('./wallet', () => ({ BuyerWalletAction: () => createElement('button', null, 'Connect wallet') }));
vi.mock('./jobs', () => ({ useJobs: () => ({ running: false, start: () => {} }) }));

const context = {
  config: { address: '0x0000000000000000000000000000000000000001', buyerAddress: '0x0000000000000000000000000000000000000002', chainId: 'base-mainnet', evmChainId: 8453, readOnly: true },
  overview: { epoch: { current: 22, genesis: 1775728461, epochDuration: 604800 } },
  theme: 'light', toggleTheme: () => {},
} as AppValue;

function render(child: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, child));
}

describe('staking dashboard displays', () => {
  it('loads originating buyer rewards without requesting wallet positions while disconnected', () => {
    const original = context.config.browserWallet;
    context.config.browserWallet = true;
    state.keys = [];
    try {
      const html = render(createElement(StakePage));
      expect(state.keys).toContain('pools');
      expect(state.keys).not.toContain('positions:current');
      expect(state.keys).toContain('rewards');
      expect(html).toContain('Buyer rewards');
      expect(html).not.toContain('Connect a wallet to view rewards.');
      expect(html).toContain('Connect a wallet to see your positions.');
      expect(html).not.toContain('To stake buyer rewards, connect your authorized wallet using the wallet button above.');
    } finally { context.config.browserWallet = original; }
  });


  it('shows buyer rewards before connection and keeps claims disabled', () => {
    const original = context.config.browserWallet;
    const previous = state.data.rewards;
    context.config.browserWallet = true;
    state.data.rewards = {
      scope: 'buyer', total: '12000000000000000000',
      staker: { total: '0', positions: [] }, sellerUsage: { total: '0', claimable: false },
      buyerUsage: { total: '7000000000000000000', operator: context.config.address, claimable: false },
      legacy: { seller: '0', buyer: '5000000000000000000', buyerClaimable: false },
      locked: { locked: '0', claimable: '0', policy: null },
    } as unknown as RewardsView;
    state.keys = [];
    try {
      const stake = render(createElement(StakePage));
      expect(stake).toContain('Buyer rewards');
      expect(stake).toContain('View buyer rewards');
      expect(stake).toContain('12');
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Buyer rewards');
      expect(html).toContain('Connect the authorized wallet');
      expect(html).toContain(context.config.buyerAddress);
      expect(html).toContain('from legacy buyer rewards');
      const claimButtons = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).filter(button => button.includes('>Claim buyer rewards</span>'));
      expect(claimButtons).toHaveLength(1);
      for (const button of claimButtons) expect(button).toContain('disabled=""');
      expect(state.keys).not.toContain('positions:current');
    } finally {
      context.config.browserWallet = original;
      state.data.rewards = previous;
    }
  });

  it('offers explicit authorization without enabling a claim when the buyer has no operator', () => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    context.config = { ...context.config, browserWallet: true, canAuthorize: true };
    state.data.rewards = { scope: 'buyer', buyerUsage: { total: '1000000000000000000', operator: null }, legacy: { buyer: '0' } };
    try {
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Authorize wallet ↗');
      expect(html).toContain('Authorize a wallet to claim or restake');
      const claim = html.match(/<button[^>]*>.*?Claim buyer rewards.*?<\/button>/)?.[0];
      expect(claim).toContain('disabled=""');
    } finally { state.data.rewards = previousData; context.config = previousConfig; }
  });

  it('uses the activation epoch for new locks and the existing end for extensions', () => {
    const props = { value: 104, max: 104, onChange: () => {} };
    expect(render(createElement(LockSlider, { ...props, startEpoch: 23 }))).toContain('2028-09-14');
    expect(render(createElement(LockSlider, { ...props, value: 1, startEpoch: 126 }))).toContain('2028-09-14');
    expect(render(createElement(LockSlider, props))).not.toContain('unlocks');
  });

  it('shows locked rewards and missing unlock policy with zero claimable balance', () => {
    state.data.rewards = {
      total: '0', staker: { total: '0', positions: [] }, sellerUsage: { total: '0', claimable: false },
      buyerUsage: { total: '0', claimable: false }, legacy: { seller: '0', buyer: '0', buyerClaimable: true },
      locked: { locked: '246820549600000000000000', claimable: '0', policy: null },
    } as unknown as RewardsView;
    const html = render(createElement(RewardsPage));
    expect(html).toContain('246,820.5496');
    expect(html).toContain('Locked pool');
    expect(html).toContain('not installed');
  });

  it('formats legacy USDC separately from ANTS and grant counts', () => {
    state.data[`seller:${context.config.address}`] = {
      agentId: 42, identityRegistered: true, registryBound: false, eligible: true,
      legacyStake: '10000000', poolActiveStake: '1000000000000000000', minPoolStake: '1',
      legacyEligibilityEnabled: true,
      starter: { initialized: false, remaining: '78', amount: '1000000000000000000', endEpoch: 126, legacyEligible: true, expired: false, claimable: true },
    } as SellerView;
    const html = render(createElement(SellerPage));
    expect(html).toContain('10 USDC');
    expect(html).toMatch(/Grants remaining[\s\S]*?78/);
    expect(html).not.toContain('&lt;0.0001 ANTS');
  });

  it('defaults the directory to stakeable pools', () => {
    const base = { weight: '0', activeStake: '0', powerShareBps: 0, yourPower: '0', volumes: [], lastEpochRewardPer1kPower: null, projectedRewardPer1kPower: null };
    const pools = [{ ...base, agentId: 1, stakeable: true, profile: { name: 'Ready seller' } }, { ...base, agentId: 2, stakeable: false, profile: { name: 'Unbound seller' } }] as unknown as PoolView[];
    const html = render(createElement(PoolsTable, { pools, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('Ready seller');
    expect(html).not.toContain('Unbound seller');
  });


  it('sorts APY and valid last-epoch volume in both directions, with unknown values last', () => {
    const pool = (agentId: number, apy: number | null, usdc: string, volumeStatus = 'available') => ({
      agentId, yield: { epoch: 24, apy, status: apy === null ? 'unavailable' : 'settled', startsAt: 0, endsAt: 604800, reward: apy === null ? null : String(BigInt(apy) * 10n ** 18n), power: '10000000000000000000000', minLockEpochs: 1, maxLockEpochs: 104 },
      volumes: [{ epoch: 24, usdc }, { epoch: 25, usdc: '999999999999999999' }], volumeStatus,
    }) as PoolView;
    const pools = [pool(1, 12, '100'), pool(2, 0, '900'), pool(3, null, '99999', 'stale')];
    const ids = (rows: PoolView[]) => rows.map(p => p.agentId);
    expect(ids(sortPoolsByMetric(pools, 'month', 'descending'))).toEqual([1, 2, 3]);
    expect(ids(sortPoolsByMetric(pools, 'month', 'ascending'))).toEqual([2, 1, 3]);
    expect(ids(sortPoolsByMetric(pools, 'volume', 'descending'))).toEqual([2, 1, 3]);
    expect(ids(sortPoolsByMetric(pools, 'volume', 'ascending'))).toEqual([1, 2, 3]);
    const html = render(createElement(PoolsTable, { pools: [], loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('Sort by APY · 1 month, ascending');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Estimated APY');
  });

  it('uses explorer ghost-rate percentage units without multiplying again', () => {
    const pool = { agentId: 1, stakeable: false, weight: '0', activeStake: '0', powerShareBps: 0, securityShareBps: 0, yourPower: '0', yourStake: '0', yourPositionIds: [], volumes: [], usagePoints: '0', weightedUsagePoints: '0', lastEpochUsagePoints: '0', lastEpochEmission: null, lastEpochRewardPer1kPower: null, projectedRewardPer1kPower: null, profile: { name: 'Seller', ghostRate: 12.4, providers: [] } } as unknown as PoolView;
    const view = { networkVolumes: [], explorer: 'https://antscan.co' } as unknown as PoolsView;
    const html = render(createElement(PoolDrawer, { pool, view, onClose: () => {}, onStake: () => {} }));
    expect(html).toContain('12.4%');
    expect(html).not.toContain('1240');
    for (const removed of ['Security share', 'Reward / 1k power', 'Usage points (this / last)', 'Model revenue breakdown unavailable', 'Your positions', 'Weighted usage points']) expect(html).not.toContain(removed);
  });
});


describe('reward staking modal', () => {
  const rewardData = {
    buyerUsage: { total: '5000000000000000000', claimable: true },
    sellerUsage: { total: '0', claimable: false, agentId: 0 },
    staker: { total: '0', positions: [] },
  } as unknown as RewardsView;
  it('enables direct rewards while disabling restricted wallet balance', () => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: false } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, {value: app}, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42, name: 'Test pool' } as unknown as PoolView], balance: '1000000000000000000', rewards: rewardData,
    })));
    expect(html).toContain('Unclaimed buyer rewards · 5 ANTS');
    expect(html).toContain('Wallet balance · 1 ANTS (transfers restricted)');
    expect(html).toContain('Stake rewards directly without claiming to your wallet.');
    expect(html).not.toContain('New stakes are unavailable');
    expect(html).toMatch(/<option(?=[^>]*disabled="")(?=[^>]*value="wallet")[^>]*>/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Review reward stake/);
  });
  it('does not enable rewards belonging to another authorized wallet', () => {
    const app = { ...context, config: { ...context.config, readOnly: false }, overview: { ...context.overview, wallet: { eth: '1000000', canTransfer: false } } } as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, {value: app}, createElement(StakeForm, {
      config: null, pools: [{ agentId: 42 } as PoolView], rewards: {...rewardData, buyerUsage: {...rewardData.buyerUsage, claimable: false}},
    })));
    expect(html).toContain('Close this form and use the wallet button above to switch to the authorized wallet for these rewards.');
    expect(html).not.toContain('>Connect wallet</button>');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});


describe('seller pool names', () => {
  it('uses the indexed seller name in selectors', () => {
    const pool = {agentId: 42, seller: '0x123', profile: {name: '  Alloy Compute  '}} as PoolView;
    expect(poolName(pool)).toBe('Alloy Compute');
    expect(poolLabel(pool)).toBe('Alloy Compute · agent 42');
  });
  it('uses an explicit pool identifier when the seller name is missing', () => {
    for (const name of [null, '', '   ']) {
      const pool = {agentId: 42, seller: '0x123', profile: {name}} as PoolView;
      expect(poolLabel(pool)).toBe('Seller pool #42');
    }
  });
});
