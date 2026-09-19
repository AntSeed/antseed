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
import { formatYieldPercent, poolApyRange } from './pool-yield';
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
  it.each([
    { readOnly: false, claimable: true, total: '7000000000000000000', visible: true },
    { readOnly: true, claimable: true, total: '7000000000000000000', visible: false },
    { readOnly: false, claimable: false, total: '7000000000000000000', visible: false },
    { readOnly: false, claimable: true, total: '0', visible: false },
  ])('keeps Stake rewards visible but enables it only for eligible buyers: %j', ({ readOnly, claimable, total, visible }) => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    const previousOverview = context.overview;
    context.config = { ...context.config, readOnly };
    context.overview = { ...context.overview, wallet: { eth: '1000000000000000' } } as AppValue['overview'];
    state.data.rewards = {
      scope: 'buyer',
      buyerUsage: { total, operator: context.config.address, claimable },
      sellerUsage: { agentId: 0 },
      legacy: { buyer: '5000000000000000000' },
    };
    try {
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Current buyer rewards');
      expect(html).toContain('Legacy buyer rewards');
      const button = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).find(button => button.includes('>Stake rewards</span>'));
      expect(button).toBeDefined();
      expect(button!.includes('disabled=""')).toBe(!visible);
      expect(html).not.toContain('>Restake</span>');
    } finally { state.data.rewards = previousData; context.config = previousConfig; context.overview = previousOverview; }
  });

  it.each([
    { canTransfer: false, wrongWallet: false, failedRead: false, walletRoute: false },
    { canTransfer: true, wrongWallet: false, failedRead: false, walletRoute: true },
    { canTransfer: true, wrongWallet: true, failedRead: false, walletRoute: false },
    { canTransfer: true, wrongWallet: false, failedRead: true, walletRoute: false },
  ])('keeps legacy buyer descriptions independent of wallet eligibility: %j', ({ canTransfer, wrongWallet, failedRead }) => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    const previousOverview = context.overview;
    const previousError = context.overviewError;
    context.config = { ...context.config, readOnly: false };
    context.overview = { ...context.overview, wallet: { eth: '1000000000000000', canTransfer } } as AppValue['overview'];
    context.overviewError = failedRead ? 'RPC unavailable' : null;
    state.data.rewards = {
      scope: 'buyer',
      buyerUsage: { total: '0', operator: wrongWallet ? context.config.buyerAddress : context.config.address, claimable: true },
      legacy: { buyer: '1991554800000000000000' },
    };
    try {
      const html = render(createElement(RewardsPage));
      const stake = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).find(button => button.includes('>Stake rewards</span>'));
      expect(stake).toContain('disabled=""');
      expect(html).toContain('Earned from using AI services under the previous rewards system.');
      expect(html).toContain('1,991.5548');
      expect(html).not.toContain('Legacy rewards have no direct staking function.');
      expect(html).not.toContain('Claiming and staking are separate transactions.');
    } finally {
      state.data.rewards = previousData;
      context.config = previousConfig;
      context.overview = previousOverview;
      context.overviewError = previousError;
    }
  });

  it.each([false, true])('keeps M002 locked rewards distinct from released rewards (policy installed: %s)', (installed) => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    const previousOverview = context.overview;
    context.config = { ...context.config, readOnly: false };
    context.overview = { ...context.overview, wallet: { eth: '1000000000000000', canTransfer: false } } as AppValue['overview'];
    state.data.rewards = {
      scope: 'all', total: installed ? '100000000000000000000' : '0',
      buyerUsage: { total: '0', operator: context.config.address, claimable: true },
      sellerUsage: { total: '0', claimable: false, agentId: 42 },
      staker: { total: '0', positions: [] },
      legacy: { buyer: '0', seller: '0', buyerClaimable: true },
      locked: { locked: '1000000000000000000000', claimable: installed ? '100000000000000000000' : '0', policy: installed ? context.config.address : null },
    };
    try {
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Locked seller rewards');
      expect(html).toContain('Past seller rewards held in the locked pool.');
      expect(html).toContain('1,000 ANTS locked');
      expect(html).not.toContain('This wallet cannot transfer ANTS into staking.');
      expect(html.includes('M002 (unlock policy) is not installed.')).toBe(!installed);
      const lockedRow = html.slice(html.indexOf('>Locked seller rewards</div>'));
      const claimButton = lockedRow.match(/<button[^>]*>.*?<\/button>/)?.[0];
      expect(claimButton).toBeDefined();
      expect(claimButton!.includes('disabled=""')).toBe(!installed);
      expect(lockedRow).not.toContain('>Restake</span>');
    } finally { state.data.rewards = previousData; context.config = previousConfig; context.overview = previousOverview; }
  });

  it('keeps seller and existing-position rewards directly restakable when wallet transfers are restricted', () => {
    const previousData = state.data.rewards;
    const previousConfig = context.config;
    const previousOverview = context.overview;
    context.config = { ...context.config, readOnly: false };
    context.overview = { ...context.overview, wallet: { eth: '1000000000000000', canTransfer: false } } as AppValue['overview'];
    state.data.rewards = {
      scope: 'all', total: '3000000000000000000',
      buyerUsage: { total: '0', operator: context.config.address, claimable: true },
      sellerUsage: { total: '1000000000000000000', claimable: true, agentId: 42 },
      staker: { total: '2000000000000000000', positions: [{ id: 7, amount: '2000000000000000000', agentId: 42 }] },
      legacy: { buyer: '0', seller: '0', buyerClaimable: true },
      locked: { locked: '0', claimable: '0', policy: null },
    };
    try {
      const html = render(createElement(RewardsPage));
      expect(html).toContain('Staking rewards');
      expect(html).toContain('Current seller rewards');
      expect(html).not.toContain('>Restake</span>');
      const buttons = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).filter(button => button.includes('>Stake rewards</span>') && !button.includes('disabled=""'));
      expect(buttons).toHaveLength(3);
      for (const button of buttons) expect(button).not.toContain('disabled=""');
    } finally { state.data.rewards = previousData; context.config = previousConfig; context.overview = previousOverview; }
  });

  it('loads originating buyer rewards without requesting wallet positions while disconnected', () => {
    const original = context.config.browserWallet;
    context.config.browserWallet = true;
    state.keys = [];
    try {
      const html = render(createElement(StakePage));
    expect(state.keys).toContain('pools');
    expect(state.keys).not.toContain('pool-stakers');
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
      expect(html).toContain('Legacy buyer rewards');
      const claimButtons = (html.match(/<button[^>]*>.*?<\/button>/g) ?? []).filter(button => button.includes('>Claim to wallet</span>'));
      expect(claimButtons).toHaveLength(2);
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
      expect(html).toContain('Authorize a wallet to claim or stake');
      const claim = html.match(/<button[^>]*>.*?Claim to wallet.*?<\/button>/)?.[0];
      expect(claim).toContain('disabled=""');
    } finally { state.data.rewards = previousData; context.config = previousConfig; }
  });

  it('uses the activation epoch for new locks and the existing end for extensions', () => {
    const props = { value: 104, max: 104, onChange: () => {} };
    expect(render(createElement(LockSlider, { ...props, startEpoch: 23 }))).toContain('2028-09-14');
    expect(render(createElement(LockSlider, { ...props, value: 1, startEpoch: 126 }))).toContain('2028-09-14');
    expect(render(createElement(LockSlider, props))).not.toContain('unlocks');
  });

  it('shows the locked balance without release-policy copy in its description', () => {
    state.data.rewards = {
      total: '0', staker: { total: '0', positions: [] }, sellerUsage: { total: '0', claimable: false },
      buyerUsage: { total: '0', claimable: false }, legacy: { seller: '0', buyer: '0', buyerClaimable: true },
      locked: { locked: '246820549600000000000000', claimable: '0', policy: null },
    } as unknown as RewardsView;
    const html = render(createElement(RewardsPage));
    expect(html).toContain('246,820.5496');
    expect(html).toContain('Locked seller rewards');
    expect(html).toContain('Past seller rewards held in the locked pool.');
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
    const html = render(createElement(PoolsTable, { pools, currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('Ready seller');
    expect(html).not.toContain('Unbound seller');
  });


  it('sorts APY and valid last-epoch volume in both directions, with unknown values last', () => {
    const pool = (agentId: number, apy: number | null, usdc: string, volumeStatus = 'available') => ({
      agentId, yield: { epoch: 24, apy, status: apy === null ? 'unavailable' : 'settled', startsAt: 0, endsAt: 604800, reward: apy === null ? null : (BigInt(apy) * 10n ** 18n).toString(), power: '10000000000000000000000', minLockEpochs: 1, maxLockEpochs: 104 },
      volumes: [{ epoch: 24, usdc }, { epoch: 25, usdc: '999999999999999999' }], volumeStatus,
    }) as PoolView;
    const pools = [pool(1, 12, '100'), pool(2, 0, '900'), pool(3, null, '99999', 'stale')];
    const ids = (rows: PoolView[]) => rows.map(p => p.agentId);
    expect(ids(sortPoolsByMetric(pools, 'apy', 'descending', 25))).toEqual([1, 2, 3]);
    expect(ids(sortPoolsByMetric(pools, 'apy', 'ascending', 25))).toEqual([2, 1, 3]);
    expect(ids(sortPoolsByMetric(pools, 'volume', 'descending', 25))).toEqual([2, 1, 3]);
    expect(ids(sortPoolsByMetric(pools, 'volume', 'ascending', 25))).toEqual([1, 2, 3]);
    const html = render(createElement(PoolsTable, { pools: [], currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('Sort by APY, ascending');
    expect(html).toContain('Total active stake (ANTS)');
    expect(html).not.toContain('Stakers');
    expect(html).not.toContain('APY range:');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Estimated APY');
  });

  it('shows and sorts completed-epoch volume without yield data', () => {
    const pool = { agentId: 1, stakeable: true, profile: null, activeStake: '3000000000000000000', volumes: [{ epoch: 24, usdc: '123000000' }, { epoch: 25, usdc: '999000000' }], volumeStatus: 'available' } as PoolView;
    const other = { ...pool, agentId: 2, volumes: [{ epoch: 24, usdc: '456000000' }] };
    expect(sortPoolsByMetric([pool, other], 'volume', 'descending', 25).map(entry => entry.agentId)).toEqual([2, 1]);
    expect(sortPoolsByMetric([pool, other], 'volume', 'ascending', 25).map(entry => entry.agentId)).toEqual([1, 2]);
    const html = render(createElement(PoolsTable, { pools: [pool], currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain('123');
    expect(html).not.toContain('999');
    expect(html).toContain('Total active stake (ANTS)');
    expect(html).not.toContain('Stakers');
  });

  it('displays a single lock-dependent range with an unsettled-reward label in the table and drawer', () => {
    const pool = { agentId: 1, stakeable: true, profile: null, activeStake: '3000000000000000000', weight: '0', powerShareBps: 0, lastEpochEmission: null, volumes: [], yield: { epoch: 24, startsAt: 0, endsAt: 604800, apr: 11, apy: 12.34, status: 'estimated', reward: '1000000000000000000', power: '10000000000000000000000', minLockEpochs: 1, maxLockEpochs: 104 } } as unknown as PoolView;
    const range = poolApyRange(pool.yield);
    const expected = `${formatYieldPercent(range.oneWeek.apy)} – ${formatYieldPercent(range.twoYears.apy)}`;
    const html = render(createElement(PoolsTable, { pools: [pool], currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    expect(html).toContain(expected);
    expect(html).not.toContain('12.34%');
    expect(html).toContain('est.');
    expect(html).toContain('Source epoch 24');
    expect(html).toContain('1 week: 1 epoch(s), 7 days; 2 years: 104 epoch(s), 728 days');
    expect(html).toContain('compounding is not automatic');
    expect(html).not.toContain('APY range:');
    expect(html).not.toContain('APY sorting uses the 1-week rate.');
    expect(html).not.toContain('APY · 1 month');
    expect(html).not.toContain('APY · 1 year');
    const view = { currentEpoch: 25, networkVolumes: [], explorer: null } as unknown as PoolsView;
    const drawer = render(createElement(PoolDrawer, { pool, view, onClose: () => {}, onStake: () => {} }));
    expect(drawer).toContain(expected);
    expect(drawer).toContain('APY');
    expect(drawer).not.toContain('APY · 1 week–2 years');
  });

  it.each([100, 200, 2000])('shows a single N/A only when an APY endpoint exceeds 10,000%% (reward: %s)', (reward) => {
    const pool = { agentId: 1, stakeable: true, profile: null, activeStake: '3000000000000000000', weight: '0', powerShareBps: 0, lastEpochEmission: null, volumes: [], yield: { epoch: 24, startsAt: 0, endsAt: 604800, status: 'estimated', reward: (BigInt(reward) * 10n ** 18n).toString(), power: '10000000000000000000000', minLockEpochs: 1, maxLockEpochs: 104 } } as unknown as PoolView;
    const range = poolApyRange(pool.yield);
    const hidden = reward !== 100;
    if (hidden) expect(range.twoYears.apy).toBeGreaterThan(10000);
    else {
      expect(range.oneWeek.apy).toBeGreaterThan(10);
      expect(range.twoYears.apy).toBeLessThan(10000);
    }
    if (reward === 200) expect(range.oneWeek.apy).toBeLessThan(10000);
    if (reward === 2000) expect(range.oneWeek.apy).toBeGreaterThan(10000);
    const expected = hidden ? 'N/A' : `${formatYieldPercent(range.oneWeek.apy)} – ${formatYieldPercent(range.twoYears.apy)}`;
    const table = render(createElement(PoolsTable, { pools: [pool], currentEpoch: 25, loading: false, onOpen: () => {}, onStake: () => {} }));
    const drawer = render(createElement(PoolDrawer, { pool, view: { currentEpoch: 25, networkVolumes: [], explorer: null } as unknown as PoolsView, onClose: () => {}, onStake: () => {} }));
    for (const html of [table, drawer]) {
      expect(html).toContain(hidden ? '>N/A</span>' : `>${expected}`);
      expect(html.includes('APY is shown as N/A when either end of the range exceeds 10,000%.')).toBe(hidden);
      expect(html).not.toContain('N/A – N/A');
      expect(html).not.toContain(' – N/A');
    }
  });

  it.each(['available', 'stale', 'unavailable'] as const)('preserves seller history as pool details load (history: %s)', (status) => {
    const previous = state.data['pool:47214'];
    delete state.data['pool:47214'];
    const pool = {
      agentId: 47214, stakeable: true, hasPool: true, profile: null, activeStake: '1000000000000000000',
      weight: '103000000000000000000', powerShareBps: 384, lastEpochEmission: '155714266005655605361',
      volumeStatus: 'available', volumes: [
        { epoch: 23, usdc: '21419582' }, { epoch: 22, usdc: '4262829' },
        { epoch: 21, usdc: '21427226' }, { epoch: 19, usdc: '0' }, { epoch: 15, usdc: '670601' },
      ],
    } as PoolView;
    const view = { currentEpoch: 23, networkVolumes: [{ epoch: 22, usdc: '7751200000' }], explorer: null } as PoolsView;
    const drawer = () => render(createElement(PoolDrawer, { pool, view, onClose: () => {}, onStake: () => {} }));
    const barEpochs = (html: string) => [...html.matchAll(/<span>Epoch (\d+)<\/span>/g)].map(match => Number(match[1]));
    try {
      const initial = drawer();
      expect(barEpochs(initial)).toEqual([15, 19, 21, 22]);
      state.data['pool:47214'] = { ...pool, currentEpoch: status === 'available' ? 23 : 24,
        volumes: status === 'available' ? [...pool.volumes].reverse() : [], volumeStatus: status };
      const refreshed = drawer();
      expect(barEpochs(refreshed)).toEqual(barEpochs(initial));
      expect(refreshed).toContain('21.42 USDC');
      expect(refreshed).toContain('0 USDC');
      expect(refreshed).toContain('Seller settled volume · completed epochs');
      expect(refreshed).toContain('Includes legacy seller activity.');
      expect(refreshed).toContain('<th class="num">Seller</th>');
      expect(refreshed.includes('Showing previously loaded history.')).toBe(status !== 'available');
      expect(refreshed).not.toContain('<p class="hint">1,000 ANTS reference stake');
    } finally {
      if (previous === undefined) delete state.data['pool:47214'];
      else state.data['pool:47214'] = previous;
    }
  });

  it('keeps missing seller history unavailable instead of fabricating zero-volume epochs', () => {
    const previous = state.data['pool:47214'];
    const pool = { agentId: 47214, stakeable: true, hasPool: true, profile: null, activeStake: '0', weight: '0', powerShareBps: 0, lastEpochEmission: null, volumeStatus: 'unavailable', volumes: [] } as unknown as PoolView;
    state.data['pool:47214'] = { ...pool, currentEpoch: 23 };
    try {
      const view = { currentEpoch: 23, networkVolumes: [], explorer: null } as unknown as PoolsView;
      const html = render(createElement(PoolDrawer, { pool, view, onClose: () => {}, onStake: () => {} }));
      expect(html).toContain('Settlement volume unavailable for completed epochs.');
      expect(html).not.toContain('volume-bar-row');
      expect(html).not.toContain('0 USDC');
    } finally {
      if (previous === undefined) delete state.data['pool:47214'];
      else state.data['pool:47214'] = previous;
    }
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
    expect(html).not.toContain('Projected APY');
    expect(html).not.toContain('Estimated first-epoch reward');
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
