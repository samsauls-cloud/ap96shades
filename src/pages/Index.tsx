import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import {
  fetchInvoices,
  updateInvoiceStatus,
  type InvoiceFilters,
  type InvoiceStatus,
} from "@/lib/supabase-queries";
import { InvoiceFiltersBar } from "@/components/ap/InvoiceFilters";
import { InvoiceTable } from "@/components/ap/InvoiceTable";
import { SummaryCards } from "@/components/ap/SummaryCards";

export default function Index() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<InvoiceFilters>({ status: "all" });

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["vendor_invoices", filters],
    queryFn: () => fetchInvoices(filters),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: InvoiceStatus }) =>
      updateInvoiceStatus(id, status),
    onSuccess: (_, { status }) => {
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      const labels: Record<InvoiceStatus, string> = {
        paid: "marked as paid",
        disputed: "flagged as disputed",
        unpaid: "reset to unpaid",
      };
      toast.success(`Invoice ${labels[status]}`);
    },
    onError: () => toast.error("Failed to update invoice status"),
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
              <FileText className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">AP Tracker</h1>
              <p className="text-xs text-muted-foreground">Accounts Payable Dashboard</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <SummaryCards invoices={invoices} />
        <InvoiceFiltersBar filters={filters} onChange={setFilters} />

        {isLoading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <InvoiceTable
            invoices={invoices}
            onStatusChange={(id, status) => statusMutation.mutate({ id, status })}
          />
        )}
      </main>
    </div>
  );
}
