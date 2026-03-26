import { useState, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fetchInvoices, fetchDistinctVendors, invoiceToCSVRow, lineItemsToCSV,
  type InvoiceFilters, type VendorInvoice,
} from "@/lib/supabase-queries";
import { StatsBar } from "@/components/invoices/StatsBar";
import { InvoiceFiltersBar } from "@/components/invoices/InvoiceFiltersBar";
import { InvoiceTable } from "@/components/invoices/InvoiceTable";
import { InvoiceDrawer } from "@/components/invoices/InvoiceDrawer";
import { InvoiceNav } from "@/components/invoices/InvoiceNav";

export default function InvoicesPage() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<InvoiceFilters>({ page: 1, perPage: 25, sortField: "invoice_date", sortDir: "desc" });
  const [selectedInvoice, setSelectedInvoice] = useState<VendorInvoice | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["vendor_invoices", filters],
    queryFn: () => fetchInvoices(filters),
  });

  const { data: vendors = [] } = useQuery({
    queryKey: ["distinct_vendors"],
    queryFn: fetchDistinctVendors,
  });

  const invoices = data?.data ?? [];
  const totalCount = data?.count ?? 0;

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
    queryClient.invalidateQueries({ queryKey: ["distinct_vendors"] });
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
        <StatsBar invoices={invoices} totalCount={totalCount} />
        <InvoiceFiltersBar filters={filters} onChange={setFilters} vendors={vendors} />

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={exportFilteredCSV}>
            <Download className="h-3 w-3 mr-1" /> Export Filtered CSV
          </Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={exportAllLineItemsCSV}>
            <Download className="h-3 w-3 mr-1" /> Export All Line Items CSV
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
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
