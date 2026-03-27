import { useNavigate } from "react-router-dom";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ChevronUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { StatusBadge, DocTypeBadge, ReconStatusBadge } from "./Badges";
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
  const navigate = useNavigate();
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
      {/* Desktop table */}
      <div className="hidden md:block rounded-lg border border-border bg-card overflow-auto">
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
              <TableHead className="text-xs font-semibold">Recon</TableHead>
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
                <TableCell>
                  <span
                    className="cursor-pointer"
                    onClick={e => {
                      e.stopPropagation();
                      const reconStatus = (inv as any).recon_status || (inv as any).reconciliation_status || 'pending';
                      if (reconStatus === 'discrepancy') {
                        navigate(`/reconciliation?invoice=${inv.invoice_number}`);
                      }
                    }}
                  >
                    <ReconStatusBadge
                      status={(inv as any).recon_status || (inv as any).reconciliation_status || 'pending'}
                      isStale={(inv as any).recon_stale === true}
                      staleReason={(inv as any).recon_stale_reason}
                    />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile card layout */}
      <div className="md:hidden space-y-2">
        {invoices.map(inv => (
          <div
            key={inv.id}
            className="rounded-lg border border-border bg-card p-3 cursor-pointer hover:bg-accent/50 transition-colors active:bg-accent/70"
            onClick={() => onRowClick(inv)}
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-0.5">
                  <DocTypeBadge docType={inv.doc_type} />
                  <span className="font-medium text-sm truncate">{inv.vendor}</span>
                </div>
                <p className="font-mono text-xs text-muted-foreground truncate">{inv.invoice_number}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="font-semibold text-sm tabular-nums">{formatCurrency(inv.total)}</p>
                <div className="flex gap-1 justify-end">
                  <StatusBadge status={inv.status} />
                  <ReconStatusBadge
                    status={(inv as any).recon_status || (inv as any).reconciliation_status || 'unreconciled'}
                    isStale={(inv as any).recon_stale === true}
                    staleReason={(inv as any).recon_stale_reason}
                  />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{formatDate(inv.invoice_date)}</span>
              {inv.po_number && <span>PO: {inv.po_number}</span>}
              <span>{getTotalUnits(inv)} units</span>
              {inv.payment_terms && <span>{inv.payment_terms}</span>}
            </div>
            {((inv as any).tags ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {((inv as any).tags ?? []).map((t: string) => (
                  <span key={t} className="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium border border-primary/20">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="hidden sm:inline">
          Showing {((page - 1) * perPage) + 1}–{Math.min(page * perPage, totalCount)} of {totalCount}
        </span>
        <span className="sm:hidden text-[10px]">
          {((page - 1) * perPage) + 1}–{Math.min(page * perPage, totalCount)} / {totalCount}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Prev
          </Button>
          {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
            const p = i + 1;
            return (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="sm"
                className="h-7 w-7 text-xs p-0 hidden sm:inline-flex"
                onClick={() => onPageChange(p)}
              >
                {p}
              </Button>
            );
          })}
          <span className="sm:hidden flex items-center text-xs px-1">{page}/{totalPages}</span>
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
