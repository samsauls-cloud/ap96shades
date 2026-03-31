import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Package, List, Clock, Calendar, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchInvoices, fetchDistinctVendors, fetchDistinctTags, fetchInvoiceStats,
  invoiceToCSVRow, lineItemsToCSV,
  type InvoiceFilters, type VendorInvoice,
} from "@/lib/supabase-queries";
import { runFullAudit, type AuditResult } from "@/lib/payment-queries";
import { StatsBar } from "@/components/invoices/StatsBar";
import { InvoiceFiltersBar } from "@/components/invoices/InvoiceFiltersBar";
import { InvoiceTable } from "@/components/invoices/InvoiceTable";
import { InvoiceDrawer } from "@/components/invoices/InvoiceDrawer";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";
import { POView } from "@/components/invoices/POView";
import { NeedsReviewQueue } from "@/components/invoices/NeedsReviewQueue";
import { AuditBanner, AuditPanel } from "@/components/invoices/AuditPanel";

export default function InvoicesPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<InvoiceFilters>({ page: 1, perPage: 25, sortField: "invoice_date", sortDir: "desc" });
  const [selectedInvoice, setSelectedInvoice] = useState<VendorInvoice | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "po">("list");
  const [auditHighlight, setAuditHighlight] = useState<string | null>(null);
  const [auditPanelOpen, setAuditPanelOpen] = useState(false);
  const openHandledRef = useRef(false);

  // Audit query
  const { data: audit, isLoading: auditLoading, refetch: refetchAudit } = useQuery({
    queryKey: ["invoice_page_audit"],
    queryFn: runFullAudit,
    staleTime: 60_000,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["vendor_invoices", filters],
    queryFn: () => fetchInvoices(filters),
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["distinct_vendors"],
    queryFn: fetchDistinctVendors,
  });

  const { data: allTags = [] } = useQuery({
    queryKey: ["distinct_tags"],
    queryFn: fetchDistinctTags,
  });

  // Stats query — filters only, no pagination
  const statsFilters = { ...filters, page: undefined, perPage: undefined };
  const { data: stats } = useQuery({
    queryKey: ["invoice_stats", statsFilters],
    queryFn: () => fetchInvoiceStats(filters),
  });

  const invoices = data?.data ?? [];
  const totalCount = data?.count ?? 0;

  useEffect(() => {
    if (selectedInvoice && invoices.length > 0) {
      const updated = invoices.find(i => i.id === selectedInvoice.id);
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedInvoice)) {
        setSelectedInvoice(updated);
      }
    }
  }, [invoices, selectedInvoice]);

  // Deep-link: auto-open invoice drawer from ?open=<id>
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId || openHandledRef.current) return;
    // Try to find in current page first
    const found = invoices.find(i => i.id === openId);
    if (found) {
      setSelectedInvoice(found);
      openHandledRef.current = true;
      searchParams.delete("open");
      setSearchParams(searchParams, { replace: true });
    } else if (!isLoading) {
      // Fetch directly if not on current page
      import("@/integrations/supabase/client").then(({ supabase }) => {
        supabase.from("vendor_invoices").select("*").eq("id", openId).maybeSingle().then(({ data: inv }) => {
          if (inv) {
            setSelectedInvoice(inv as VendorInvoice);
          }
          openHandledRef.current = true;
          searchParams.delete("open");
          setSearchParams(searchParams, { replace: true });
        });
      });
    }
  }, [searchParams, invoices, isLoading]);

  const handleSort = useCallback((field: string) => {
    setFilters(prev => ({
      ...prev,
      sortField: field,
      sortDir: prev.sortField === field && prev.sortDir === "desc" ? "asc" : "desc",
    }));
  }, []);

  const handlePageChange = useCallback((page: number) => {
    setFilters(prev => ({ ...prev, page }));
  }, []);

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
    queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
    queryClient.invalidateQueries({ queryKey: ["distinct_vendors"] });
    queryClient.invalidateQueries({ queryKey: ["distinct_tags"] });
    queryClient.invalidateQueries({ queryKey: ["vendor_invoices_po_view"] });
    queryClient.invalidateQueries({ queryKey: ["needs_review_invoices"] });
    queryClient.invalidateQueries({ queryKey: ["needs_review_count"] });
  };

  const exportFilteredCSV = () => {
    const header = "Type,Vendor,Invoice #,PO #,Account #,Date,Units,Total,Terms,Status";
    const rows = invoices.map(invoiceToCSVRow);
    const csv = [header, ...rows].join("\n");
    downloadCSV(csv, "invoices_filtered.csv");
    toast.success("CSV exported");
  };

  const exportAllLineItemsCSV = () => {
    const all = invoices.map(lineItemsToCSV).join("\n");
    downloadCSV(all, "line_items_all.csv");
    toast.success("Line items CSV exported");
  };

  return (
    <div className="min-h-screen bg-background">
      <InvoiceNav />
      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-5">
        <StatsBar stats={stats} />

        {/* Audit Banner + collapsible panel */}
        <AuditBanner
          audit={audit ?? null}
          totalInvoices={stats?.total_invoices ?? 0}
          onScrollTo={(category) => {
            setAuditHighlight(category);
            setAuditPanelOpen(true);
            setTimeout(() => {
              document.getElementById(`audit-${category}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              setTimeout(() => setAuditHighlight(null), 3000);
            }, 100);
          }}
        />
        {audit && (audit.missingPayments.length > 0 || audit.mathDiscrepancies.length > 0 || audit.unknownVendors.length > 0 || audit.duplicateInvoices.length > 0) && (
          <div>
            <button
              onClick={() => setAuditPanelOpen(o => !o)}
              className="text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors mb-2"
            >
              {auditPanelOpen ? "▼ Hide audit details" : "▶ Show audit details"}
            </button>
            {auditPanelOpen && (
              <AuditPanel
                audit={audit}
                onRefresh={() => refetchAudit()}
                isLoading={auditLoading}
                totalInvoices={stats?.total_invoices ?? 0}
                highlightSection={auditHighlight as any}
              />
            )}
          </div>
        )}

        <InvoiceFiltersBar filters={filters} onChange={setFilters} vendors={vendors} tags={allTags} />

        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex rounded-lg border border-border overflow-hidden">
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="sm"
              className="text-xs h-7 rounded-none gap-1"
              onClick={() => setViewMode("list")}
            >
              <List className="h-3 w-3" /> List
            </Button>
            <Button
              variant={viewMode === "po" ? "default" : "ghost"}
              size="sm"
              className="text-xs h-7 rounded-none gap-1"
              onClick={() => setViewMode("po")}
            >
              <Package className="h-3 w-3" /> PO View
            </Button>
          </div>
          <Button
            variant={filters.sortField === "imported_at" ? "default" : "outline"}
            size="sm"
            className="text-xs h-7 gap-1"
            onClick={() => {
              if (filters.sortField === "imported_at") {
                setFilters(prev => ({ ...prev, sortField: "invoice_date", sortDir: "desc" }));
              } else {
                setFilters(prev => ({ ...prev, sortField: "imported_at", sortDir: "desc" }));
              }
            }}
          >
            <Clock className="h-3 w-3" /> Recently Uploaded
          </Button>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={exportFilteredCSV}>
            <Download className="h-3 w-3 mr-1" /> <span className="hidden sm:inline">Export Filtered</span> CSV
          </Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={exportAllLineItemsCSV}>
            <Download className="h-3 w-3 mr-1" /> <span className="hidden sm:inline">Export All</span> Line Items
          </Button>
        </div>

        {/* Needs Review Queue */}
        <NeedsReviewQueue onOpenInvoice={setSelectedInvoice} />

        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : viewMode === "po" ? (
          <POView onRowClick={setSelectedInvoice} />
        ) : (
          <InvoiceTable
            invoices={invoices}
            filters={filters}
            onSort={handleSort}
            onRowClick={setSelectedInvoice}
            totalCount={totalCount}
            onPageChange={handlePageChange}
          />
        )}

        <InvoiceDrawer
          invoice={selectedInvoice}
          open={!!selectedInvoice}
          onClose={() => setSelectedInvoice(null)}
          onUpdate={handleRefresh}
        />
      </main>
    </div>
  );
}

function downloadCSV(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
