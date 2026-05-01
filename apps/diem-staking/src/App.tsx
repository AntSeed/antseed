// Top-level page composition. Thin — all interactivity lives in StakeCard,
// all presentation in the Layout components. This file's job is:
//   1. Compute the top-line derived values (APY, alpha-strip cap display)
//   2. Hand them down to the card + layout
//   3. Render the static sections in the order the design specifies

import { useMemo } from 'react';

import {
  useDiemPrice,
  usePoolAgeDays,
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
import { DAYS_PER_YEAR } from './lib/epoch';
import { DIEM_STAKING_PROXY, isAddressSet } from './lib/addresses';
import { ALPHA_MAX_TOTAL_STAKE_DIEM_BASE } from './lib/protocol';

export function App() {
  const diemPrice = useDiemPrice();
  const pool = usePoolStats();
  const { poolAgeDays } = usePoolAgeDays();

  // APY = (all-time USDC inflow / days pool has existed × 365) / pool TVL.
  // Pool TVL is live staked DIEM valued at the current DIEM price.
  const apy = useMemo(() => {
    if (diemPrice == null || diemPrice <= 0) return 0;
    if (pool.totalUsdcDistributedEver == null || pool.totalStaked == null || poolAgeDays == null) return 0;
    const tvlDiem = toDiemNumber(pool.totalStaked);
    if (tvlDiem <= 0 || poolAgeDays <= 0) return 0;
    const annualizedUsdc = (toUsdcNumber(pool.totalUsdcDistributedEver) / poolAgeDays) * DAYS_PER_YEAR;
    const poolValueUsd = tvlDiem * diemPrice;
    if (poolValueUsd <= 0) return 0;
    return (annualizedUsdc / poolValueUsd) * 100;
  }, [diemPrice, pool.totalStaked, pool.totalUsdcDistributedEver, poolAgeDays]);

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
        <Hero diemPrice={diemPrice} apy={apy} />
        <StakeCard diemPrice={diemPrice} poolAgeDays={poolAgeDays} apy={apy} />
        <ClaimBanner />
        <HowItWorks />
        <DualCards />
        <FAQ />
      </main>
      <Footer proxyAddress={proxyAddress} />
    </>
  );
}
