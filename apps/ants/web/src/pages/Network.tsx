import type { OverviewView } from '../../../src/api-types';
import { api } from '../api';
import { Details } from '../components/Details';
import { EmissionsSection } from '../components/EmissionsSection';
import { useEpochDate } from '../components/Epoch';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Facts, Panel } from '../components/Panel';
import { StatTile, Tiles } from '../components/StatTile';
import { UsageSection } from '../components/UsageSection';
import { VerificationRegistry } from '../components/Verification';
import { usePageData } from '../data';
import { epochStartAt, formatAnts, formatDuration, formatUtc } from '../format';
import { useNow } from '../hooks';

/** Footer route: epoch, emissions, dynamic shares, usage and the verification registry on one page. */
export function NetworkPage() {
  const overview = usePageData('overview', api.overview);
  const verification = usePageData('verification:own', () => api.verification(), 5 * 60_000);
  const now = useNow(1000);
  const data = overview.data;
  return (
    <>
      <h1 className="page-title">Network</h1>
      {overview.error && !data ? <ErrorBox error={overview.error} onRetry={overview.refresh} /> : null}
      {!data && overview.loading ? <Skeleton rows={4} /> : null}
      {data ? <EpochSection data={data} fetchedAt={overview.updatedAt} now={now} /> : null}

      <EmissionsSection />
      <UsageSection />

      <Panel className="panel-collapsible">
        <Details summary="Verification registry">
          {verification.error && !verification.data ? <ErrorBox error={verification.error} onRetry={verification.refresh} /> : null}
          {!verification.data && verification.loading ? <Skeleton rows={3} /> : null}
          {verification.data ? <VerificationRegistry data={verification.data} /> : null}
        </Details>
      </Panel>
    </>
  );
}

function EpochSection({ data, fetchedAt, now }: { data: OverviewView; fetchedAt: number | null; now: number }) {
  const { epoch, network } = data;
  const boundaryAt = fetchedAt !== null ? fetchedAt + epoch.secondsToBoundary * 1000 : epoch.nextBoundaryAt * 1000;
  const secondsLeft = Math.max(0, Math.floor((boundaryAt - now) / 1000));
  const nextEpochDate = useEpochDate(epoch.current + 1);
  return (
    <>
      <Tiles>
        <StatTile label="Current epoch" value={epoch.current} sub={formatUtc(epochStartAt(epoch.current, epoch.genesis, epoch.epochDuration))} />
        <StatTile label="Next boundary in" value={formatDuration(secondsLeft)} sub={nextEpochDate ?? undefined} />
        <StatTile label="Effective epoch" value={epoch.effective ?? '—'} sub={epoch.effective !== null ? formatUtc(epochStartAt(epoch.effective, epoch.genesis, epoch.epochDuration)) : 'not deployed'} />
      </Tiles>
      <Panel title="Network">
        {network ? (
          <Facts
            items={[
              ['Total active stake', `${formatAnts(network.totalActiveStake)} ANTS`],
              ['Epoch emission', `${formatAnts(network.epochEmission)} ANTS`],
              ['Budgets this epoch', `staker ${formatAnts(network.stakerBudget)} · buyer ${formatAnts(network.usageBuyerBudget)} · seller ${formatAnts(network.usageSellerBudget)} ANTS`],
              ['ANTS supply', `${formatAnts(network.antsTotalSupply, 0)} of ${formatAnts(network.antsMaxSupply, 0)} ANTS`],
            ]}
          />
        ) : (
          <span className="muted">Network figures are not available before the recognized-usage stack is deployed.</span>
        )}
        <Details summary="Details" className="mt">
          <Facts
            items={[
              ['Epoch length', formatDuration(epoch.epochDuration)],
              ['Genesis', formatUtc(epoch.genesis)],
              ['Total power weight', network ? formatAnts(network.totalPowerWeight) : '—'],
            ]}
          />
        </Details>
      </Panel>
    </>
  );
}
