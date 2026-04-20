// Top-level page composition. Thin — all interactivity lives in StakeCard,
// all presentation in the Layout components. This file's job is:
//   1. Compute the top-line derived values (APR, alpha-strip cap display)
//   2. Hand them down to the card + layout
//   3. Render the static sections in the order the design specifies

import { useMemo } from 'react';

import {
  useDiemPrice,
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
import { fmtNum, toDiemNumber, toUsdcNumber } from './lib/format';
import { EPOCHS_PER_YEAR } from './lib/epoch';
import { DIEM_STAKING_PROXY, isAddressSet } from './lib/addresses';

export function App() {
  const diemPrice = useDiemPrice();
  const { lastEpochUsdc } = useLastEpochUsdc();
  const pool = usePoolStats();

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

  const maxStakeDisplay = useMemo(() => {
    if (pool.maxTotalStake == null || pool.maxTotalStake === 0n) return null;
    return fmtNum(toDiemNumber(pool.maxTotalStake));
  }, [pool.maxTotalStake]);

  const proxyAddress = isAddressSet(DIEM_STAKING_PROXY) ? DIEM_STAKING_PROXY : null;

  return (
    <>
      <AlphaStrip maxStakeDisplay={maxStakeDisplay} />
      <Nav />
      <main>
        <Hero diemPrice={diemPrice} apr={apr} />
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
