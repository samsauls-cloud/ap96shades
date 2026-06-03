import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Wallet, Trash2, Loader2, Undo2 } from "lucide-react";
import {
  fetchVendorCreditBalance,
  fetchVendorCreditLedger,
  fetchAllVendorCreditBalances,
  deleteVendorCredit,
  reverseVendorCreditApplication,
} from "@/lib/vendor-credits";
import { formatCurrency } from "@/lib/supabase-queries";
import { useNavigate } from "react-router-dom";
import { AddVendorCreditDialog } from "@/components/invoices/AddVendorCreditDialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface Props {
  vendor: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SOURCE_LABEL: Record<string, string> = {
  remittance_overpay: "Overpayment",
  invoice_application: "Applied to invoice",
  manual_adjustment: "Manual adjustment",
  reversal: "Reversal",
  returned_ra: "Returned / RA",
  other: "Other",
};

export function VendorCreditDrawer({ vendor, open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: balance = 0 } = useQuery({
    queryKey: ["vendor_credit_balances", vendor.toLowerCase()],
    enabled: open && !!vendor,
    queryFn: () => fetchVendorCreditBalance(vendor),
  });

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["vendor_credit_ledger", vendor.toLowerCase()],
    enabled: open && !!vendor,
    queryFn: () => fetchVendorCreditLedger(vendor),
  });

  const oldestFirst = [...entries].reverse();
  let running = 0;
  const withRunning = oldestFirst.map(e => {
    running += Number(e.amount);
    return { ...e, runningBalance: running };
  }).reverse();

  const lastActivity = entries[0]?.occurred_on ?? null;

  async function handleDelete(id: string) {
    if (!confirm("Delete this credit entry? This cannot be undone.")) return;
    setDeletingId(id);
    try {
      await deleteVendorCredit(id);
      toast.success("Credit entry deleted");
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
    } catch (e: any) {
      toast.error(`Delete failed: ${e?.message ?? "unknown error"}`, { duration: 8000 });
    } finally {
      setDeletingId(null);
    }
  }

  async function handleReverse(id: string) {
    if (!confirm("Reverse this applied credit?\n\nThe vendor's balance will be restored and the invoice will owe this amount again.")) return;
    setDeletingId(id);
    try {
      await reverseVendorCreditApplication(id);
      toast.success("Credit application reversed");
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
      queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments_detail"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
      queryClient.invalidateQueries({ queryKey: ["ap_full_audit"] });
    } catch (e: any) {
      toast.error(`Reverse failed: ${e?.message ?? "unknown error"}`, { duration: 8000 });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-emerald-500" />
            <span>{vendor}</span>
            <span className="ml-auto text-emerald-500 tabular-nums">{formatCurrency(balance)}</span>
          </SheetTitle>
          {lastActivity && (
            <p className="text-xs text-muted-foreground">Last activity: {lastActivity}</p>
          )}
          <div className="pt-2">
            <AddVendorCreditDialog
              lockedVendor={vendor}
              buttonLabel="Add credit for this vendor"
            />
          </div>
        </SheetHeader>

        <div className="mt-4">
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No credit ledger entries.</p>
          ) : (
            <div className="space-y-1.5">
              {withRunning.map(e => {
                const isPositive = e.amount > 0;
                const clickable = !!e.related_invoice_id;
                const isApplication = e.source_type === "invoice_application";
                const isReversal = e.source_type === "reversal";
                const canDelete = !isApplication && !isReversal && !e.related_payment_id;
                const canReverse = isApplication;
                return (
                  <div
                    key={e.id}
                    className="p-2.5 rounded border text-xs space-y-0.5 hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div
                        role={clickable ? "button" : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        onClick={() => clickable && navigate(`/invoices?open=${e.related_invoice_id}`)}
                        className={`flex-1 min-w-0 ${clickable ? "cursor-pointer" : ""}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono">{e.occurred_on}</span>
                          <Badge variant="outline" className="text-[10px] h-4 px-1">
                            {SOURCE_LABEL[e.source_type] ?? e.source_type}
                          </Badge>
                          {clickable && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1 text-primary">
                              linked
                            </Badge>
                          )}
                        </div>
                        {e.description && (
                          <p className="mt-0.5 text-muted-foreground truncate">{e.description}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`font-bold tabular-nums ${isPositive ? "text-emerald-500" : "text-orange-400"}`}>
                          {isPositive ? "+" : ""}{formatCurrency(e.amount)}
                        </p>
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          bal {formatCurrency(e.runningBalance)}
                        </p>
                      </div>
                      {canReverse && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-amber-500"
                          onClick={() => handleReverse(e.id)}
                          disabled={deletingId === e.id}
                          title="Reverse / unapply this credit"
                        >
                          {deletingId === e.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Undo2 className="h-3 w-3" />}
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(e.id)}
                          disabled={deletingId === e.id}
                          title="Delete entry"
                        >
                          {deletingId === e.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Trash2 className="h-3 w-3" />}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Pill that opens the ledger drawer; hides when balance ≤ 0. */
export function VendorCreditBadge({ vendor, balance: providedBalance }: { vendor: string; balance?: number }) {
  const [open, setOpen] = useState(false);
  const { data: fetched = 0 } = useQuery({
    queryKey: ["vendor_credit_balances", vendor.toLowerCase()],
    enabled: providedBalance === undefined,
    queryFn: () => fetchVendorCreditBalance(vendor),
  });
  const balance = providedBalance ?? fetched;

  if (balance <= 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 transition-colors"
        title={`Vendor credit balance: ${formatCurrency(balance)} — click for ledger`}
      >
        <Wallet className="h-2.5 w-2.5" />
        Credit: {formatCurrency(balance)}
      </button>
      <VendorCreditDrawer vendor={vendor} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Bulk balance map for table rows — react-query so it refreshes on invalidation. */
export function useVendorCreditBalanceMap() {
  const { data } = useQuery({
    queryKey: ["vendor_credit_balances"],
    queryFn: fetchAllVendorCreditBalances,
  });
  return (vendor: string) => {
    if (!vendor || !data) return 0;
    const key = vendor.toLowerCase();
    return data.find(r => r.vendor_key === key)?.balance ?? 0;
  };
}
