import type { ReactNode } from "react";
import { SectionNote } from "./layout";

/** One column of a {@link Table}. */
export interface Column<Row> {
  /** Stable key of the column. */
  id: string;
  /** The header text. */
  label: string;
  /** Keeps the header for screen readers only, e.g. "Actions" over a column of buttons. */
  hideLabel?: boolean;
  /** Draws the cell of a row. */
  cell: (row: Row) => ReactNode;
  /** `right` also turns on tabular numbers, for counts and sizes. */
  align?: "left" | "right";
  /** Extra classes for each cell, e.g. `font-mono` for IDs or `max-w-64 truncate` for long text. */
  className?: string;
}

interface TableProps<Row> {
  /** Name of the table for screen readers. */
  label: string;
  /** The columns, left to right. */
  columns: Column<Row>[];
  /** The rows, in the order to show them. The table does not sort. */
  rows: readonly Row[];
  /** A stable key for each row. */
  rowKey: (row: Row) => string;
  /** Makes each row a button (click or Enter). Leave out when only buttons inside cells act. */
  onRowPress?: (row: Row) => void;
  /** Shown in place of the table when there are no rows. */
  empty?: string;
}

/** A plain table as in claude.ai's connector list: muted headers, a divider under each row. */
export function Table<Row>({ label, columns, rows, rowKey, onRowPress, empty = "Nothing here yet." }: TableProps<Row>) {
  if (!rows.length) return <SectionNote>{empty}</SectionNote>;
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-chat-divider text-left text-chat-muted">
            {columns.map((c) => <th key={c.id} scope="col" className={`px-3 py-2 font-normal ${c.align === "right" ? "text-right" : ""}`}>{c.hideLabel ? <span className="sr-only">{c.label}</span> : c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={`border-b border-chat-divider ${onRowPress ? "cursor-pointer hover:bg-chat-hover" : ""}`}
              {...(onRowPress && { onClick: () => onRowPress(row), tabIndex: 0, onKeyDown: (e) => { if (e.key === "Enter") onRowPress(row); } })}>
              {columns.map((c) => <td key={c.id} className={`px-3 py-2.5 ${c.align === "right" ? "text-right tabular-nums" : ""} ${c.className ?? ""}`}>{c.cell(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
