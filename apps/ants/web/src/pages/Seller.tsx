import { useState } from 'react';
import type { SellerView } from '../../../src/api-types';
import { api } from '../api';
import { AddressLink } from '../components/AddressLink';
import { ActionButton } from '../components/Confirm';
import { Details } from '../components/Details';
import { EpochCell } from '../components/Epoch';
import { ErrorBox, Skeleton } from '../components/Feedback';
import { Input } from '../components/Field';
import { Facts, Panel } from '../components/Panel';
import { Pill } from '../components/Pill';
import { StatTile, Tiles } from '../components/StatTile';
import { OwnSellerStatus, ProofLookup, ProofSubmit, SellerLookup } from '../components/Verification';
import { usePageData } from '../data';
import { formatAnts, isPositiveInt } from '../format';

export function SellerPage() {
  const page = usePageData('seller', api.seller);
  const data = page.data;
  return (
    <>
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      {page.error && data ? <div className="status-line">Refresh failed: {page.error}</div> : null}
      {!data && page.loading ? <Skeleton rows={6} /> : null}
      {data ? <SellerBody data={data} /> : null}

      <Panel title="Wash-trading status">
        <OwnSellerStatus />
      </Panel>

      <Panel className="panel-collapsible">
        <Details summary="Submit a seller proof">
          <div className="stack-lg">
            <ProofSubmit />
            <div>
              <div className="section-label">Proof status</div>
              <ProofLookup />
            </div>
          </div>
        </Details>
      </Panel>

      <Panel className="panel-collapsible">
        <Details summary="Look up another seller">
          <SellerLookup />
        </Details>
      </Panel>
    </>
  );
}

function YesNo({ value }: { value: boolean | null }) {
  if (value === null) return <span className="muted">n/a</span>;
  return value ? <Pill tone="accent">yes</Pill> : <Pill tone="muted">no</Pill>;
}

function SellerBody({ data }: { data: SellerView }) {
  const starter = data.starter;
  return (
    <>
      <Tiles>
        <StatTile label="Agent id" value={data.agentId || '—'} sub={data.identityRegistered ? 'identity registered' : 'no ERC-8004 identity'} />
        <StatTile label="Eligible" value={data.eligible ? 'yes' : 'no'} sub={data.registryBound ? 'bound in seller registry' : 'not bound'} />
        <StatTile label="Pool active stake" value={formatAnts(data.poolActiveStake)} unit="ANTS" sub={data.minPoolStake !== null ? `min ${formatAnts(data.minPoolStake)} ANTS` : undefined} />
      </Tiles>

      <Panel title="Identity and registry">
        <Facts
          items={[
            ['ERC-8004 identity', <YesNo value={data.identityRegistered} />],
            ['Seller registry binding', <YesNo value={data.registryBound} />],
            ['Legacy stake', `${formatAnts(data.legacyStake, 4)} ANTS`],
            ['Legacy eligibility path', <YesNo value={data.legacyEligibilityEnabled} />],
          ]}
        />
        <div className="mt">
          <RegisterAction data={data} />
        </div>
        <div className="hint mt">
          CLI equivalent: <code>antseed seller register</code>
        </div>
      </Panel>

      <Panel
        title="Starter grant"
        actions={
          starter ? (
            starter.claimable ? (
              <Pill tone="accent">claimable</Pill>
            ) : starter.expired ? (
              <Pill tone="muted">expired</Pill>
            ) : starter.initialized ? (
              <Pill tone="amber">initialized</Pill>
            ) : (
              <Pill tone="muted">not initialized</Pill>
            )
          ) : null
        }
      >
        {starter ? (
          <>
            <Facts
              items={[
                ['Remaining', `${formatAnts(starter.remaining, 4)} ANTS`],
                ['Grant amount', `${formatAnts(starter.amount, 4)} ANTS`],
                ['Claim window ends', <EpochCell epoch={starter.endEpoch} />],
                ['Legacy eligible', <YesNo value={starter.legacyEligible} />],
              ]}
            />
            <div className="mt">
              <ActionButton
                label="Claim starter"
                variant="primary"
                title="Claim starter grant"
                path="/api/seller/claim-starter"
                body={{}}
                disabled={!starter.claimable}
                disabledReason={starter.expired ? 'The starter grant window has expired.' : 'The starter grant is not claimable for this wallet.'}
                summary={[
                  ['Wallet', <span className="mono">{data.address}</span>],
                  ['Amount', <span className="mono">{formatAnts(starter.remaining, 4)} ANTS</span>],
                  ['Contract', <span className="mono">{starter.contract ?? '—'}</span>],
                ]}
              />
            </div>
            <Details summary="Details" className="mt">
              <Facts
                items={[
                  ['Contract', starter.contract ? <AddressLink value={starter.contract} short={false} /> : '—'],
                  ['Initialized', <YesNo value={starter.initialized} />],
                  ['Expired', <YesNo value={starter.expired} />],
                ]}
              />
              <div className="hint mt">
                CLI equivalent: <code>antseed seller legacy claim-starter</code>
              </div>
            </Details>
          </>
        ) : (
          <span className="muted">No starter grant contract on this chain.</span>
        )}
      </Panel>
    </>
  );
}

function RegisterAction({ data }: { data: SellerView }) {
  const [agentId, setAgentId] = useState(data.agentId > 0 ? String(data.agentId) : '');
  const body: { agentId?: number } = agentId.trim() ? { agentId: Number(agentId) } : {};
  return (
    <div className="form-row">
      <Input label="Agent id (optional)" hint="Leave empty to register a new ERC-8004 identity" width="md" inputMode="numeric" value={agentId} onChange={(e) => setAgentId(e.target.value)} />
      <ActionButton
        label={data.registryBound ? 'Re-register binding' : 'Register binding'}
        variant="primary"
        title="Register seller binding"
        path="/api/seller/register"
        body={body}
        validate={() => (agentId.trim() && !isPositiveInt(agentId) ? 'Agent id must be a positive integer.' : null)}
        summary={[
          ['Wallet', <span className="mono">{data.address}</span>],
          ['Agent id', <span className="mono">{agentId.trim() || 'new identity'}</span>],
          ['Currently bound', data.registryBound ? 'yes' : 'no'],
        ]}
      >
        <p className="hint mt">Binds this wallet to the agent id in the seller registry (registering an ERC-8004 identity first when none is given).</p>
      </ActionButton>
    </div>
  );
}
