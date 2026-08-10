import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createInitialUiState } from '../../core/state';
import type { DesktopBridge } from '../../types/bridge';
import { initCreditsModule } from './credits.js';

test('refreshCredits updates balance fields from creditsGetInfo', async () => {
  const uiState = createInitialUiState();
  const bridge: DesktopBridge = {
    creditsGetInfo: async () => ({
      ok: true,
      data: {
        evmAddress: '0xabc',
        operatorAddress: '0xdef',
        balanceUsdc: '10',
        reservedUsdc: '2',
        availableUsdc: '8',
        pendingUsdc: '1',
        spendableUsdc: '9',
        walletUsdc: '6',
        totalOwnedUsdc: '15',
        creditLimitUsdc: '20',
      },
      error: null,
    }),
  };
  const api = initCreditsModule({ bridge, uiState });

  await api.refreshCredits();

  assert.equal(uiState.creditsAvailableUsdc, '8');
  assert.equal(uiState.creditsReservedUsdc, '2');
  assert.equal(uiState.creditsTotalUsdc, '10');
  assert.equal(uiState.creditsPendingUsdc, '1');
  assert.equal(uiState.creditsSpendableUsdc, '9');
  assert.equal(uiState.creditsWalletUsdc, '6');
  assert.equal(uiState.creditsTotalOwnedUsdc, '15');
  assert.equal(uiState.creditsCreditLimitUsdc, '20');
  assert.equal(uiState.creditsEvmAddress, '0xabc');
  assert.equal(uiState.creditsOperatorAddress, '0xdef');
});

test('refreshPaymentSummary updates usage, spending history, channels, and rewards when bridge methods exist', async () => {
  const uiState = createInitialUiState();
  const bridge: DesktopBridge = {
    paymentsGetBuyerUsage: async () => ({
      ok: true,
      data: {
        totalRequests: 3,
        totalInputTokens: '11',
        totalOutputTokens: '22',
        totalSettlements: 2,
        uniqueSellers: 1,
        activeChannels: 1,
      },
      error: null,
    }),
    paymentsGetBuyerSpendHistory: async () => ({
      ok: true,
      data: {
        available: true,
        source: 'antscan',
        unavailableReason: null,
        days: [{
          day: '2026-08-10',
          dayStart: 1_786_320_000,
          spentUsdc: '250000',
          inputTokens: '100',
          outputTokens: '25',
        }],
      },
      error: null,
    }),
    paymentsGetChannels: async () => ({
      ok: true,
      data: [{
        channelId: 'channel-1',
        peerId: 'peer-1',
        seller: '0xseller',
        sellerDisplayName: 'Seller One',
        reserveMax: '100',
        cumulativeSigned: '50',
        reservedAt: 1,
        status: 'active',
        requestCount: 3,
        settledUsdc: '0',
        inputTokens: '11',
        outputTokens: '22',
        cooperativeCloseSupported: true,
      }],
      error: null,
    }),
    paymentsGetRewardsSummary: async () => ({
      ok: true,
      data: {
        available: true,
        pendingAnts: '1.5',
        currentEpoch: 7,
        transfersEnabled: false,
        error: null,
      },
      error: null,
    }),
  };
  const api = initCreditsModule({ bridge, uiState });

  await api.refreshPaymentSummary();

  assert.equal(uiState.creditsBuyerUsage?.totalRequests, 3);
  assert.equal(uiState.creditsBuyerSpendHistory?.days[0]?.spentUsdc, '250000');
  assert.equal(uiState.creditsChannels[0]?.channelId, 'channel-1');
  assert.equal(uiState.creditsRewards?.pendingAnts, '1.5');
  assert.equal(uiState.creditsSummaryLoading, false);
});

test('missing summary bridge methods do not throw', async () => {
  const uiState = createInitialUiState();
  const api = initCreditsModule({ bridge: {}, uiState });

  await api.refreshPaymentSummary();

  assert.equal(uiState.creditsBuyerUsage, null);
  assert.equal(uiState.creditsBuyerSpendHistory, null);
  assert.deepEqual(uiState.creditsChannels, []);
  assert.equal(uiState.creditsRewards, null);
});

test('refreshPaymentSummary preserves spending history when its refresh fails', async () => {
  const uiState = createInitialUiState();
  uiState.creditsBuyerSpendHistory = {
    available: true,
    source: 'antscan',
    unavailableReason: null,
    days: [{
      day: '2026-08-09',
      dayStart: 1_786_233_600,
      spentUsdc: '100000',
      inputTokens: '80',
      outputTokens: '20',
    }],
  };
  const bridge: DesktopBridge = {
    paymentsGetBuyerUsage: async () => ({ ok: true, data: null, error: null }),
    paymentsGetBuyerSpendHistory: async () => ({ ok: false, data: null, error: 'offline' }),
  };
  const api = initCreditsModule({ bridge, uiState });

  await api.refreshPaymentSummary();

  assert.equal(uiState.creditsBuyerSpendHistory.days[0]?.spentUsdc, '100000');
});
