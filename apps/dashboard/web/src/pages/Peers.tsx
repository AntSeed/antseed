import React, { useEffect, useState, useCallback } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  SortingState,
} from '@tanstack/react-table';
import { NetworkResponse, NetworkPeer } from './api-types';
import { useWebSocket, type WsEvent } from '../hooks/useWebSocket';
import { debugError } from '../utils/debug';

const REFRESH_INTERVAL = 10_000;

const columnHelper = createColumnHelper<NetworkPeer>();

function getReputationClass(score: number): string {
  if (score >= 80) {
    return 'rep-high';
  }
  if (score >= 50) {
    return 'rep-mid';
  }
  return 'rep-low';
}

const columns = [
  columnHelper.accessor('peerId', {
    header: 'Peer ID',
    cell: (info) => {
      const id = info.getValue();
      return <span className="mono" title={id}>{id.slice(0, 10)}...</span>;
    },
  }),
  columnHelper.accessor('source', {
    header: 'Source',
    cell: (info) => {
      const source = info.getValue() ?? 'dht';
      const cls = source === 'daemon' ? 'source-badge-daemon' : 'source-badge-dht';
      return <span className={`source-badge ${cls}`}>{source.toUpperCase()}</span>;
    },
  }),
  columnHelper.accessor('providers', {
    header: 'Provider',
    cell: (info) => (info.getValue() ?? []).join(', '),
  }),
  columnHelper.accessor('capacityMsgPerHour', {
    header: 'Capacity (msg/hr)',
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor('inputUsdPerMillion', {
    header: 'Input $/1M',
    cell: (info) => `$${info.getValue().toFixed(2)}`,
  }),
  columnHelper.accessor('outputUsdPerMillion', {
    header: 'Output $/1M',
    cell: (info) => `$${info.getValue().toFixed(2)}`,
  }),
  columnHelper.accessor('reputation', {
    header: 'Reputation',
    cell: (info) => {
      const score = info.getValue();
      const pct = score.toFixed(0);
      const className = getReputationClass(score);
      return <span className={className}>{pct}%</span>;
    },
  }),
];

export function Peers() {
  const [peers, setPeers] = useState<NetworkPeer[]>([]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [scanning, setScanning] = useState(false);

  const fetchPeers = useCallback(() => {
    fetch('/api/network')
      .then((res) => res.ok ? res.json() : null)
      .then((data: NetworkResponse | null) => setPeers(data?.peers ?? []))
      .catch(debugError);
  }, []);

  useWebSocket({
    network_peers_updated: (event: WsEvent) => {
      const nextPeers = (event.data as NetworkPeer[]) ?? [];
      setPeers(nextPeers);
    },
  });

  useEffect(() => {
    fetchPeers();
    const interval = setInterval(fetchPeers, REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchPeers]);

  const handleScanNow = useCallback(() => {
    setScanning(true);
    fetch('/api/network/scan', { method: 'POST' })
      .then((res) => res.json())
      .then(() => {
        // Refresh peers after scan
        fetchPeers();
      })
      .catch(debugError)
      .finally(() => setScanning(false));
  }, [fetchPeers]);

  const table = useReactTable({
    data: peers,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="peers-page">
      <div className="page-header">
        <h2>Peers ({peers.length})</h2>
        <div className="page-header-actions">
          <input
            type="text"
            className="filter-input"
            placeholder="Filter peers..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
          />
          <button
            className="scan-btn"
            onClick={handleScanNow}
            disabled={scanning}
          >
            {scanning ? 'Scanning...' : 'Scan Now'}
          </button>
        </div>
      </div>
      <div className="table-container">
        <table className="data-table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className={header.column.getIsSorted() ? 'sorted' : ''}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {header.column.getIsSorted() === 'asc' ? ' \u25B2' : ''}
                    {header.column.getIsSorted() === 'desc' ? ' \u25BC' : ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
