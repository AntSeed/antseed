import { Skeleton } from './ui';
import { Fragment, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
  title?: string;
  className?: string;
}

interface Props<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string | number;
  empty?: ReactNode;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  isSelected?: (row: T) => boolean;
  /** Extra class per row (e.g. muted pools). */
  rowClass?: (row: T) => string | undefined;
  /** When it returns a node for a row, that node is rendered in a full-width line under the row. */
  renderDetail?: (row: T) => ReactNode;
  footer?: ReactNode;
}

export function Table<T>({ columns, rows, rowKey, empty, loading, onRowClick, isSelected, rowClass, renderDetail, footer }: Props<T>) {
  const cellClass = (column: Column<T>) =>
    [column.align === 'right' ? 'num' : '', column.mono ? 'mono' : '', column.className ?? ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={[column.align === 'right' ? 'num' : '', column.className ?? ''].filter(Boolean).join(' ') || undefined} title={column.title}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0
            ? Array.from({ length: 3 }, (_, i) => (
                <tr key={`skel-${i}`}>
                  {columns.map((column) => (
                    <td key={column.key}>
                      <Skeleton width="70%" height={12} />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {!loading && rows.length === 0 ? (
            <tr>
              <td className="empty" colSpan={columns.length}>
                {empty ?? 'Nothing to show.'}
              </td>
            </tr>
          ) : null}
          {rows.map((row, index) => {
            const selected = isSelected?.(row) ?? false;
            const detail = renderDetail?.(row);
            const classes = [onRowClick ? 'clickable' : '', selected ? 'selected' : '', detail ? 'expanded' : '', rowClass?.(row) ?? ''].filter(Boolean).join(' ') || undefined;
            return (
              <Fragment key={rowKey(row)}>
                <tr className={classes} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                  {columns.map((column) => (
                    <td key={column.key} className={cellClass(column)}>
                      {column.render(row, index)}
                    </td>
                  ))}
                </tr>
                {detail ? (
                  <tr className="detail-row">
                    <td colSpan={columns.length}>{detail}</td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}
