import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolView, PositionView } from '../../src/api-types';
import { PositionSummary, PositionsCard } from './components/Positions';
import { PoolsTable } from './components/Pools';

const mocks = vi.hoisted(() => ({ page: vi.fn(), table: vi.fn(), menu: vi.fn(), epoch: vi.fn() }));
vi.mock('./data', () => ({ usePageData: mocks.page }));
vi.mock('./app-context', () => ({ useEpochInfo: mocks.epoch }));
vi.mock('./components/Menu', async original => {
  const actual = await original<typeof import('./components/Menu')>();
  return { ...actual, Menu: (props: Parameters<typeof actual.Menu>[0]) => {
    mocks.menu(props);
    return createElement(actual.Menu, props);
  } };
});
vi.mock('./components/Table', async original => {
  const actual = await original<typeof import('./components/Table')>();
  return { ...actual, Table: (props: Parameters<typeof actual.Table>[0]) => {
    mocks.table(props);
    return createElement(actual.Table, props);
  } };
});

function position(overrides: Partial<PositionView> = {}): PositionView {
  return {
    id: 29, agentId: 86939, owner: '0x148C5602f160F21E52144dC2d60E11A2C20D6ad6',
    amount: '125000000000000000000', weightAmount: '125000000000000000000',
    stakeStartEpoch: 26, stakeEndEpoch: 38, closedAtEpoch: 0, withdrawn: false,
    state: 'active', withdrawableEpoch: 27, changePending: false, maxLocked: false,
    slashBps: 5000, projectedSlashBps: 5000, slashedAmount: '62500000000000000000',
    returnedAmount: '62500000000000000000', pendingReward: '0', epochsRemaining: 11,
    ...overrides,
  };
}

function renderPosition(overrides: Partial<PositionView> = {}, pools: PoolView[] = []) {
  mocks.page.mockReturnValue({ data: { positions: [position(overrides)] }, loading: false, error: null });
  return renderToStaticMarkup(createElement(PositionsCard, { pools }));
}

function pool(name: string | null): PoolView {
  return {
    agentId: 86939, seller: position().owner,
    profile: { name, providers: [], modelsServed: null, uniqueBuyers: null, requestCount: null, lifetimeVolumeUsdc: null, ghostRate: null, lastSettledAt: null },
    hasPool: true, stakeable: true, activeStake: '0', weight: '0', powerShareBps: 0, securityShareBps: 0,
    volumes: [], usagePoints: '0', weightedUsagePoints: '0', lastEpochUsagePoints: '0', lastEpochEmission: null,
    lastEpochEmissionSettled: false, lastEpochRewardPer1kPower: null, projectedRewardPer1kPower: null,
    yourStake: '0', yourPower: '0', yourPoolShareBps: 0, yourPositionIds: [29],
  };
}

beforeEach(() => { vi.clearAllMocks(); mocks.epoch.mockReturnValue(null); });

describe('position summary', () => {
  it('shows the pending lock duration, activation date and unchanged unlock date', () => {
    mocks.epoch.mockReturnValue({ current: 27, genesis: 1775728461, epochDuration: 604800 });
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position({ state: 'pending', stakeStartEpoch: 28, stakeEndEpoch: 40, epochsRemaining: 12 }), pools: [pool('Anvil Seller Beta')] }));
    expect(html).toContain('Lock duration');
    expect(html).toContain('84 days');
    expect(html).toContain('starts 2026-10-22 UTC');
    expect(html).toContain('unlocks 2027-01-14 UTC');
  });

  it('labels active duration as remaining rather than restarting the lock', () => {
    mocks.epoch.mockReturnValue({ current: 27, genesis: 1775728461, epochDuration: 604800 });
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position(), pools: [] }));
    expect(html).toContain('Remaining lock');
    expect(html).toContain('up to 77 days');
    expect(html).toContain('unlocks 2026-12-31 UTC');
  });

  it('falls back to epoch numbers when date metadata is unavailable', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position(), pools: [] }));
    expect(html).toContain('Remaining lock');
    expect(html).toContain('unlocks epoch 38');
    expect(html).not.toContain('days');
  });

  it('does not show a countdown for a perpetual lock', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position({ maxLocked: true }), pools: [] }));
    expect(html).toContain('No scheduled unlock');
    expect(html).not.toContain('Remaining lock');
    expect(html).not.toContain('unlocks epoch');
  });

  it('identifies expired locks rather than showing a remaining duration', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position({ state: 'matured', epochsRemaining: 0 }), pools: [] }));
    expect(html).toContain('Lock expired');
    expect(html).not.toContain('Remaining lock');
  });

  it('identifies the source seller and amount instead of a position ID', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position({ id: 30, amount: '200000000000000000000' }), pools: [pool('Anvil Seller Beta')] }));
    expect(html).toContain('Anvil Seller Beta');
    expect(html).toContain('200 ANTS');
    expect(html).not.toContain('#30');
    expect(html).not.toContain('position(s)');
  });

  it('preserves the amount when seller metadata is missing', () => {
    const html = renderToStaticMarkup(createElement(PositionSummary, { position: position(), pools: [] }));
    expect(html).toContain('Unknown seller');
    expect(html).toContain('125 ANTS');
  });
});

describe('seller directory', () => {
  it.each(['Anvil Seller Alpha', null])('shows only the seller name in its first column (%s)', name => {
    const html = renderToStaticMarkup(createElement(PoolsTable, { pools: [pool(name)], currentEpoch: 27, loading: false, onOpen: vi.fn(), onStake: vi.fn() }));
    expect(html).toContain('>Seller<');
    expect(html).toContain(name ?? 'Unnamed seller');
    expect(html).not.toContain('86939');
    expect(html).not.toContain('0x148C');
    expect(html).toContain('1 seller</span>');
  });
});

describe('positions table', () => {
  it('shows seller names instead of position and pool IDs', () => {
    const html = renderPosition({}, [pool('Anvil Seller Alpha')]);
    expect(html).toContain('>Seller<');
    expect(html).toContain('Anvil Seller Alpha');
    expect(html).not.toContain('>ID<');
    expect(html).not.toContain('>Pool<');
    expect(html).not.toContain('#29');
    expect(html).not.toContain('86939');
    expect(html).not.toContain('Select position 29');
  });

  it.each([false, true])('groups allowed actions in the menu when maxLocked is %s', maxLocked => {
    const html = renderPosition({ maxLocked });
    expect(html).toContain('More actions for position 29');
    const props = mocks.menu.mock.calls[0]![0];
    expect(props.items.map((item: { label: string }) => item.label)).toEqual(['Move allocation', 'Extend', 'Withdraw']);
    expect(html).not.toContain('Split');
    expect(html).not.toContain('Merge');
    expect(html).not.toContain('Extend');
    expect(html).not.toContain('Max lock');
    expect(html).not.toContain('Move allocation');
    expect(html).not.toContain('Withdraw');
  });

  it.each([null, '   '])('falls back to the seller address when its name is %s', name => {
    const html = renderPosition({}, [pool(name)]);
    expect(html).toContain('0x148C…6ad6');
    expect(html).not.toContain('Unknown seller');
  });

  it('handles unavailable seller metadata', () => {
    expect(renderPosition()).toContain('Unknown seller');
  });

  it('does not expand row details and retains explicit position actions', () => {
    const html = renderPosition();
    const props = mocks.table.mock.calls[0]![0];
    expect(props.onRowClick).toBeUndefined();
    expect(props.renderDetail).toBeUndefined();
    expect(html).not.toContain('Early-exit slash');
    expect(html).not.toContain('Epochs left');
    expect(html).not.toContain('Change pending');
    expect(html).toContain('More actions for position 29');
    expect(html).not.toContain('Select position 29');
  });

  it('removes selection checkboxes, row highlights and the bulk action bar', () => {
    const html = renderPosition();
    const props = mocks.table.mock.calls[0]![0];
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Select all open positions');
    expect(html).not.toContain('bulk-bar');
    expect(html).not.toContain('>clear<');
    expect(props.isSelected).toBeUndefined();
    expect(props.columns.map((column: { key: string }) => column.key)).toEqual(['seller', 'amount', 'unlocks', 'state', 'reward', 'actions']);
    expect(mocks.menu.mock.calls[0]![0].items.map((item: { label: string }) => item.label)).toEqual(['Move allocation', 'Extend', 'Withdraw']);
  });

  it('explains status and lock expiry without implying automatic withdrawal', () => {
    const html = renderPosition({ state: 'matured' });
    expect(html).toContain('>Status<');
    expect(html).toContain('The lock has expired.');
    expect(html).toContain('Funds are not withdrawn automatically.');
  });

  it('does not imply an automatic unlock date for an existing perpetual lock', () => {
    const html = renderPosition({ maxLocked: true });
    expect(html).toContain('No scheduled unlock');
    expect(html).toContain('lock does not count down automatically');
    expect(html).toContain('Lock-management controls are currently unavailable');
  });

  it.each([
    ['pending', 'Waiting for the stake activation epoch.'],
    ['active', 'The staking position is active and its lock has not expired.'],
  ] as const)('explains %s status', (state, description) => {
    expect(renderPosition({ state })).toContain(description);
  });
});
