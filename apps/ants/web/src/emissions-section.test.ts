import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EmissionsView, NetworkSummary } from '../../src/api-types';
import { AppContext, type AppValue } from './app-context';
import { EmissionsSection, budgetRows } from './components/EmissionsSection';

const ANTS = 10n ** 18n;
const emissions: EmissionsView = {
  currentEpoch: 23, effectiveEpoch: 22, genesis: 1775728461, epochDuration: 604800, halvingInterval: 104,
  initialEmission: (5_000_000n * ANTS).toString(), currentRate: '8267195767195767195', cumulativeThroughCurrent: (120_000_000n * ANTS).toString(),
  shareDenominator: 100_000, emissionsReserve: null, legacyEscrow: null, epochVolumeUsdc: '1958110581',
  minters: [
    { name: 'seller-pools', id: '0x1', controller: '0x00000000000000000000000000000000000000a1', shareBps: 40_000, epochBudget: (2_000_000n * ANTS).toString() },
    { name: 'usage', id: '0x2', controller: '0x00000000000000000000000000000000000000a2', shareBps: 20_000, epochBudget: (1_000_000n * ANTS).toString() },
    { name: 'team', id: '0x3', controller: '0x00000000000000000000000000000000000000a3', shareBps: 15_000, epochBudget: (750_000n * ANTS).toString() },
  ],
  dynamicStaker: { minShareBps: 2_000, maxShareBps: 40_000, stakeShareTarget: (400_000_000n * ANTS).toString() },
  dynamicUsage: { buyerMinShareBps: 5_000, buyerMaxShareBps: 10_000, sellerMinShareBps: 5_000, sellerMaxShareBps: 10_000, volumeShareTarget: '1000000000000' },
  legacy: null,
};
const network: NetworkSummary = {
  totalActiveStake: (26n * ANTS).toString(), totalPowerWeight: '0', epochEmission: (5_000_000n * ANTS).toString(),
  stakerBudget: (100_000n * ANTS).toString(), usageBuyerBudget: (250_500n * ANTS).toString(), usageSellerBudget: (250_500n * ANTS).toString(),
  antsTotalSupply: '0', antsMaxSupply: '0',
};

vi.mock('./data', () => ({ usePageData: () => ({ data: emissions, error: null, loading: false, refresh: () => {} }) }));

describe('emissions budget table', () => {
  const rows = budgetRows(emissions, network);
  it('reports each dynamic bucket against its gate ceiling and the live figure that sets it', () => {
    const stakers = rows.find((row) => row.key === 'stakers')!;
    expect(stakers.ceiling).toBe(2_000_000n * ANTS);
    expect(stakers.allocated).toBe(100_000n * ANTS);
    const usage = rows.find((row) => row.key === 'usage')!;
    expect(usage.allocated).toBe(501_000n * ANTS);
    expect(rows.find((row) => row.key === 'unallocated')!.allocated).toBe((1_900_000n + 499_000n) * ANTS);
    expect(rows.map((row) => row.key)).toEqual(['stakers', 'usage', 'buyers', 'sellers', 'team', 'unallocated']);
  });
  it('renders the table without an editable column and with the dynamic rules', () => {
    const context = { config: { address: '0x0000000000000000000000000000000000000001', chainId: 'base-mainnet', evmChainId: 8453, readOnly: true }, overview: { epoch: { current: 23, genesis: 1775728461, epochDuration: 604800 }, network }, theme: 'dark', toggleTheme: () => {} } as unknown as AppValue;
    const html = renderToStaticMarkup(createElement(AppContext.Provider, { value: context }, createElement(EmissionsSection)));
    expect(html).not.toMatch(/Editable|FIXED|>yes</);
    expect(html).toContain('Epoch 23 emission');
    expect(html).toContain('5,000,000 ANTS');
    expect(html).toContain('2.00% – 40.00% of the emission');
    expect(html).toContain('2.00% of emission');
    expect(html).toContain('400,000,000');
    expect(html).toContain('$2.0k');
    expect(html).toContain('Unallocated');
    expect(html).toContain('next at epoch 104');
  });
  it('keeps unknown live figures blank instead of zero', () => {
    const blank = budgetRows(emissions, null);
    expect(blank.find((row) => row.key === 'stakers')!.allocated).toBeNull();
    expect(blank.some((row) => row.key === 'unallocated')).toBe(false);
  });
});
