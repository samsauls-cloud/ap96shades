import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { StatusBadge, DocTypeBadge } from "./Badges";
import type { VendorInvoice, InvoiceFilters } from "@/lib/supabase-queries";
import { formatCurrency, formatDate, getTotalUnits } from "@/lib/supabase-queries";

interface Props {
  invoices: VendorInvoice[];
  filters: InvoiceFilters;
  onSort: (field: string) => void;
  onRowClick: (inv: VendorInvoice) => void;
  totalCount: number;
  onPageChange: (page: number) => void;
}

function SortIcon({ field, filters }: { field: string; filters: InvoiceFilters }) {
  if (filters.sortField !== field) return <ChevronsUpDown className="h-3 w-3 opacity-30" />;
  return filters.sortDir === "asc"
    ? <ChevronUp className="h-3 w-3" />
    : <ChevronDown className="h-3 w-3" />;
}

function SortableHead({ field, label, filters, onSort, className }: {
  field: string; label: string; filters: InvoiceFilters; onSort: (f: string) => void; className?: string;
}) {
  return (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground transition-colors ${className ?? ""}`}
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-1 text-xs font-semibold">
        {label}
        <SortIcon field={field} filters={filters} />
      </span>
    </TableHead>
  );
}

export function InvoiceTable({ invoices, filters, onSort, onRowClick, totalCount, onPageChange }: Props) {
  const perPage = filters.perPage ?? 25;
  const page = filters.page ?? 1;
  const totalPages = Math.ceil(totalCount / perPage);

  if (invoices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <p className="text-base font-medium">No invoices found</p>
        <p className="text-sm">Try adjusting your filters or import some documents.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-card overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <SortableHead field="doc_type" label="Type" filters={filters} onSort={onSort} className="w-[60px]" />
              <SortableHead field="vendor" label="Vendor" filters={filters} onSort={onSort} />
              <SortableHead field="invoice_number" label="Invoice/Order #" filters={filters} onSort={onSort} />
              <SortableHead field="po_number" label="PO #" filters={filters} onSort={onSort} />
              <TableHead className="text-xs font-semibold">Account #</TableHead>
              <SortableHead field="invoice_date" label="Date" filters={filters} onSort={onSort} />
              <TableHead className="text-xs font-semibold text-right">Units</TableHead>
              <SortableHead field="total" label="Total" filters={filters} onSort={onSort} className="text-right" />
              <TableHead className="text-xs font-semibold">Terms</TableHead>
              <TableHead className="text-xs font-semibold">Tags</TableHead>
              <SortableHead field="status" label="Status" filters={filters} onSort={onSort} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map(inv => (
              <TableRow
                key={inv.id}
                className="border-border cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => onRowClick(inv)}
              >
                <TableCell><DocTypeBadge docType={inv.doc_type} /></TableCell>
                <TableCell className="font-medium text-sm">{inv.vendor}</TableCell>
                <TableCell className="font-mono text-xs">{inv.invoice_number}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{inv.po_number || "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{inv.account_number || "—"}</TableCell>
                <TableCell className="text-xs">{formatDate(inv.invoice_date)}</TableCell>
                <TableCell className="text-xs text-right tabular-nums">{getTotalUnits(inv)}</TableCell>
                <TableCell className="text-right font-semibold text-sm tabular-nums">{formatCurrency(inv.total)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{inv.payment_terms || "—"}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {((inv as any).tags ?? []).map((t: string) => (
                      <span key={t} className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium border border-primary/20">
                        {t}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell><StatusBadge status={inv.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Showing {((page - 1) * perPage) + 1}–{Math.min(page * perPage, totalCount)} of {totalCount}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
            const p = i + 1;
            return (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="sm"
                className="h-7 w-7 text-xs p-0"
                onClick={() => onPageChange(p)}
              >
                {p}
              </Button>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
