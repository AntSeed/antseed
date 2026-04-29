// Top-level page composition. Thin — all interactivity lives in StakeCard,
// all presentation in the Layout components. This file's job is:
//   1. Compute the top-line derived values (APR, alpha-strip cap display)
//   2. Hand them down to the card + layout
//   3. Render the static sections in the order the design specifies

import { useMemo } from 'react';

import {
  useDiemPrice,
  useEpochClock,
  useLastEpochUsdc,
  usePoolStats,
} from './lib/hooks';
import {
  AlphaStrip,
  ClaimBanner,
  DualCards,
  FAQ,
  Footer,
  Hero,
  HowItWorks,
  Nav,
} from './components/Layout';
import { StakeCard } from './components/StakeCard';
import { fmtDuration, fmtNum, toDiemNumber, toUsdcNumber } from './lib/format';
import { computeDailyResetClock, EPOCHS_PER_YEAR } from './lib/epoch';
import { DIEM_STAKING_PROXY, isAddressSet } from './lib/addresses';
import { ALPHA_MAX_TOTAL_STAKE_DIEM_BASE } from './lib/protocol';

export function App() {
  const diemPrice = useDiemPrice();
  const { lastEpochUsdc } = useLastEpochUsdc();
  const pool = usePoolStats();
  const epochClock = useEpochClock();

  // APR = (USDC distributed last epoch per DIEM × epochs/yr) / DIEM price
  const apr = useMemo(() => {
    if (diemPrice == null || diemPrice <= 0) return 0;
    if (lastEpochUsdc == null || pool.totalStaked == null) return 0;
    const tvlDiem = toDiemNumber(pool.totalStaked);
    if (tvlDiem <= 0) return 0;
    const lastEpochUsd = toUsdcNumber(lastEpochUsdc);
    const usdcPerDiemPerEpoch = lastEpochUsd / tvlDiem;
    return (usdcPerDiemPerEpoch * EPOCHS_PER_YEAR) / diemPrice * 100;
  }, [diemPrice, lastEpochUsdc, pool.totalStaked]);

  // Prefer the live on-chain value. Fall back to the constructor-set default
  // (10 DIEM) when the read hasn't returned yet or the proxy isn't deployed,
  // so the AlphaStrip renders the correct cap from the first paint. Only
  // treat an explicit on-chain `0` as "uncapped" (owner raised / removed).
  const maxStakeDisplay = useMemo(() => {
    const cap = pool.maxTotalStake ?? ALPHA_MAX_TOTAL_STAKE_DIEM_BASE;
    if (cap === 0n) return null;
    return fmtNum(toDiemNumber(cap));
  }, [pool.maxTotalStake]);

  const proxyAddress = isAddressSet(DIEM_STAKING_PROXY) ? DIEM_STAKING_PROXY : null;

  return (
    <>
      <AlphaStrip maxStakeDisplay={maxStakeDisplay} />
      <Nav />
      <main>
        <Hero
          diemPrice={diemPrice}
          apr={apr}
          veniceCapacityTotalUsd={pool.veniceCapacityTotalUsd}
          veniceCapacityLeftUsd={pool.veniceCapacityLeftUsd}
          veniceResetCountdown={fmtDuration(computeDailyResetClock(Math.floor(Date.now() / 1000)).remainingSecs)}
          nextAntsDistributionCountdown={fmtDuration(epochClock.remainingSecs)}
        />
        <StakeCard diemPrice={diemPrice} lastEpochUsdc={lastEpochUsdc} apr={apr} />
        <ClaimBanner />
        <HowItWorks />
        <DualCards />
        <FAQ />
      </main>
      <Footer proxyAddress={proxyAddress} />
    </>
  );
}
