import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppContext, type AppValue } from './app-context';
import { LockSlider } from './components/LockSlider';
import { RewardsPage } from './pages/Rewards';
import { SellerPage } from './pages/Seller';
import { PoolsTable, PoolDrawer } from './components/Pools';
import type { PoolView, PoolsView, RewardsView, SellerView } from '../../src/api-types';

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('./data', () => ({ usePageData: (key: string) => ({ data: state.data[key] ?? null, error: null, loading: false, refresh: () => {} }) }));
vi.mock('./jobs', () => ({ useJobs: () => ({ running: false, start: () => {} }) }));

const context = {
  config: { address: '0x0000000000000000000000000000000000000001', chainId: 'base-mainnet', evmChainId: 8453, readOnly: true },
  overview: { epoch: { current: 22, genesis: 1775728461, epochDuration: 604800 } },
  theme: 'light', toggleTheme: () => {},
} as AppValue;

function render(child: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, child));
}

describe('staking dashboard displays', () => {
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
    state.data.seller = {
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

  it('uses explorer ghost-rate percentage units without multiplying again', () => {
    const pool = { agentId: 1, stakeable: false, weight: '0', activeStake: '0', powerShareBps: 0, securityShareBps: 0, yourPower: '0', yourStake: '0', yourPositionIds: [], volumes: [], usagePoints: '0', weightedUsagePoints: '0', lastEpochUsagePoints: '0', lastEpochEmission: null, lastEpochRewardPer1kPower: null, projectedRewardPer1kPower: null, profile: { name: 'Seller', ghostRate: 12.4, providers: [] } } as unknown as PoolView;
    const view = { networkVolumes: [], explorer: 'https://antscan.co' } as unknown as PoolsView;
    const html = render(createElement(PoolDrawer, { pool, view, onClose: () => {}, onStake: () => {} }));
    expect(html).toContain('12.4%');
    expect(html).not.toContain('1240');
  });
});
