import { api } from '../api';
import { useConfig } from '../app-context';
import { AddressLink } from '../components/AddressLink';
import { ErrorBox } from '../components/Feedback';
import { Facts, Panel } from '../components/Panel';
import { Table } from '../components/Table';
import { usePageData } from '../data';

export function AddressesPage() {
  const config = useConfig();
  const page = usePageData('overview', api.overview);
  const data = page.data;
  const rows = Object.entries(data?.addresses ?? {})
    .map(([name, address]) => ({ name, address }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <h1 className="page-title">Addresses</h1>
      {page.error && !data ? <ErrorBox error={page.error} onRetry={page.refresh} /> : null}
      <Panel title="Environment">
        <Facts
          items={[
            ['Chain', <span>{config.chainId}</span>],
            ['EVM chain id', config.evmChainId],
            ['RPC URL', data ? <span className="break">{data.rpcUrl}</span> : '…'],
            ['Wallet', <AddressLink value={config.address} short={false} copy />],
            ['Data dir', <span className="break">{config.dataDir}</span>],
            ['Mode', config.readOnly ? 'read-only (no wallet)' : 'signing'],
          ]}
        />
      </Panel>
      <Panel title="Protocol contracts">
        <Table
          columns={[
            { key: 'name', label: 'Contract', render: (r) => r.name },
            { key: 'address', label: 'Address', render: (r) => <AddressLink value={r.address} short={false} copy /> },
          ]}
          rows={rows}
          rowKey={(r) => r.name}
          loading={page.loading && !data}
          empty="No contract addresses are configured for this chain."
        />
      </Panel>
    </>
  );
}
