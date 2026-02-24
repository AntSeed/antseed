import React, { useEffect, useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  SortingState,
} from '@tanstack/react-table';
import { SessionsResponse } from './api-types';
import { SessionMetrics } from './shared-types';
import { debugError } from '../utils/debug';

const columnHelper = createColumnHelper<SessionMetrics>();

const columns = [
  columnHelper.accessor('sessionId', {
    header: 'Session ID',
    cell: (info) => {
      const id = info.getValue();
      return <span className="mono" title={id}>{id.slice(0, 12)}...</span>;
    },
  }),
  columnHelper.accessor('provider', {
    header: 'Provider',
  }),
  columnHelper.accessor('totalTokens', {
    header: 'Tokens',
    cell: (info) => {
      const t = info.getValue();
      return t >= 1000 ? `${(t / 1000).toFixed(1)}K` : String(t);
    },
  }),
  columnHelper.accessor('totalRequests', {
    header: 'Requests',
  }),
  columnHelper.accessor('durationMs', {
    header: 'Duration',
    cell: (info) => formatDuration(info.getValue()),
  }),
  columnHelper.accessor('avgLatencyMs', {
    header: 'Avg Latency',
    cell: (info) => `${info.getValue().toFixed(0)}ms`,
  }),
  columnHelper.accessor('peerSwitches', {
    header: 'Switches',
  }),
];

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function Sessions() {
  const [sessions, setSessions] = useState<SessionMetrics[]>([]);
  const [total, setTotal] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([]);

  useEffect(() => {
    fetch('/api/sessions')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: SessionsResponse) => {
        setSessions(data.sessions);
        setTotal(data.total);
      })
      .catch(debugError);
  }, []);

  const table = useReactTable({
    data: sessions,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="sessions-page">
      <div className="page-header">
        <h2>Sessions ({total})</h2>
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
