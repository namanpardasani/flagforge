import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Checkbox } from "./checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

export interface Column<Row> {
  header: string;
  cell: (row: Row) => ReactNode;
  /** Right-align numeric columns so digits line up. */
  align?: "left" | "right";
  className?: string;
}

interface DataTableProps<Row extends { id: string }> {
  rows: readonly Row[];
  columns: readonly Column<Row>[];
  /** Describes the table to screen readers. */
  label: string;
  /** What one row is called, for the checkbox labels ("Select flag route-optimizer-v2"). */
  rowLabel: (row: Row) => string;
}

/**
 * Table with row selection. The selection logic (a Set of ids, select-all with a "some selected"
 * mixed state) is adapted from Watermelon UI's "data-table-1"; it is made generic over the row
 * type here and restyled to the tokens. Prompt 2 builds the flag list on top of it.
 */
export function DataTable<Row extends { id: string }>({ rows, columns, label, rowLabel }: DataTableProps<Row>) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const allSelected = rows.length > 0 && selectedIds.size === rows.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
  const headerState = useMemo(() => (allSelected ? true : someSelected ? "indeterminate" : false), [allSelected, someSelected]);

  const toggleAll = (checked: boolean) => setSelectedIds(checked ? new Set(rows.map((r) => r.id)) : new Set());
  const toggleRow = (id: string, checked: boolean) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div>
      <Table aria-label={label}>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10">
              <Checkbox checked={headerState} onCheckedChange={(value) => toggleAll(value === true)} aria-label="Select all rows" />
            </TableHead>
            {columns.map((column) => (
              <TableHead key={column.header} className={cn(column.align === "right" && "text-right", column.className)}>
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const selected = selectedIds.has(row.id);
            return (
              <TableRow key={row.id} data-selected={selected}>
                <TableCell className="w-10">
                  <Checkbox checked={selected} onCheckedChange={(value) => toggleRow(row.id, value === true)} aria-label={`Select ${rowLabel(row)}`} />
                </TableCell>
                {columns.map((column) => (
                  <TableCell key={column.header} className={cn(column.align === "right" && "text-right", column.className)}>
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p aria-live="polite" className="caption border-t border-hairline px-3 py-2 text-faint">
        {selectedIds.size} of {rows.length} selected
      </p>
    </div>
  );
}
