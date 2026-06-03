import { useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Wallet, Ban, Loader2, Undo2 } from "lucide-react";
import {
  fetchVendorCreditBalance,
  fetchVendorCreditLedger,
  fetchAllVendorCreditBalances,
  voidVendorCredit,
  reverseVendorCreditApplication,
} from "@/lib/vendor-credits";
import { fetchVendorAliasMap, resolveVendorKey } from "@/lib/vendor-alias-resolver";
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

type PendingAction =
  | { kind: "void"; id: string; amount: number; description: string | null; reference: string | null }
  | { kind: "reverse"; id: string; amount: number; invoiceNumber: string | null };

export function VendorCreditDrawer({ vendor, open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

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

  // Set of credit-row ids that have already been voided (a reversal row points to them).
  const voidedIds = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if ((e as any).reversed_credit_id) set.add((e as any).reversed_credit_id);
    }
    return set;
  }, [entries]);

  const oldestFirst = [...entries].reverse();
  let running = 0;
  const withRunning = oldestFirst.map(e => {
    running += Number(e.amount);
    return { ...e, runningBalance: running };
  }).reverse();

  const lastActivity = entries[0]?.occurred_on ?? null;

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["vendor_credit_balances"] });
    queryClient.invalidateQueries({ queryKey: ["vendor_credit_ledger"] });
    queryClient.invalidateQueries({ queryKey: ["vendor_invoices"] });
  }

  async function performVoid(id: string) {
    setBusyId(id);
    try {
      const { newBalance } = await voidVendorCredit(id);
      toast.success(`Entry voided. ${vendor} available balance: ${formatCurrency(newBalance)}`);
      invalidateAll();
    } catch (e: any) {
      toast.error(`Void failed: ${e?.message ?? "unknown error"}`, { duration: 8000 });
    } finally {
      setBusyId(null);
      setPending(null);
    }
  }

  async function performReverse(id: string) {
    setBusyId(id);
    try {
      await reverseVendorCreditApplication(id);
      toast.success("Credit application reversed");
      invalidateAll();
      queryClient.invalidateQueries({ queryKey: ["invoice_payments"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_payments_detail"] });
      queryClient.invalidateQueries({ queryKey: ["invoice_stats"] });
      queryClient.invalidateQueries({ queryKey: ["ap_full_audit"] });
    } catch (e: any) {
      toast.error(`Reverse failed: ${e?.message ?? "unknown error"}`, { duration: 8000 });
    } finally {
      setBusyId(null);
      setPending(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-emerald-500" />
            <span>{vendor}</span>
            <span className="ml-auto text-emerald-500 tabular-nums">{formatCurrency(balance)} available</span>
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
                const alreadyVoided = voidedIds.has(e.id);
                const canVoid = !isApplication && !isReversal && !alreadyVoided && !(e as any).related_payment_id;
                const canReverse = isApplication && !alreadyVoided;
                return (
                  <div
                    key={e.id}
                    className={`p-2.5 rounded border text-xs space-y-0.5 hover:bg-muted/40 transition-colors ${alreadyVoided ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div
                        role={clickable ? "button" : undefined}
                        tabIndex={clickable ? 0 : undefined}
                        onClick={() => clickable && navigate(`/invoices?open=${e.related_invoice_id}`)}
                        className={`flex-1 min-w-0 ${clickable ? "cursor-pointer" : ""}`}
                      >
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono">{e.occurred_on}</span>
                          <Badge variant="outline" className="text-[10px] h-4 px-1">
                            {SOURCE_LABEL[e.source_type] ?? e.source_type}
                          </Badge>
                          {alreadyVoided && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1 text-amber-500 border-amber-500/40">
                              Reversed
                            </Badge>
                          )}
                          {(e as any).reference && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1 font-mono">
                              {(e as any).reference}
                            </Badge>
                          )}
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
                          onClick={() => setPending({ kind: "reverse", id: e.id, amount: Number(e.amount), invoiceNumber: (e as any).related_invoice_id ? ((e as any).invoice_number ?? null) : null })}
                          disabled={busyId === e.id}
                          title="Reverse / unapply this credit"
                        >
                          {busyId === e.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Undo2 className="h-3 w-3" />}
                        </Button>
                      )}
                      {canVoid && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setPending({ kind: "void", id: e.id, amount: Number(e.amount), description: e.description ?? null, reference: (e as any).reference ?? null })}
                          disabled={busyId === e.id}
                          title="Void this entry (inserts offsetting reversal row)"
                        >
                          {busyId === e.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Ban className="h-3 w-3" />}
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

      <AlertDialog open={!!pending} onOpenChange={(v) => { if (!v && !busyId) setPending(null); }}>
        <AlertDialogContent>
          {pending?.kind === "reverse" && (() => {
            const restore = Math.abs(pending.amount);
            const after = balance + restore;
            return (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reverse credit application</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-2 text-sm">
                      <p>
                        This un-applies the credit. The vendor's balance is restored and the invoice will owe this
                        amount again.
                      </p>
                      <div className="rounded border bg-muted/30 p-2 space-y-1 font-mono text-xs">
                        {pending.invoiceNumber && (
                          <div className="flex justify-between"><span className="text-muted-foreground">Invoice</span><span>{pending.invoiceNumber}</span></div>
                        )}
                        <div className="flex justify-between"><span className="text-muted-foreground">Amount restored</span><span className="text-emerald-500">+{formatCurrency(restore)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Vendor balance</span><span>{formatCurrency(balance)} → <span className="text-emerald-500">{formatCurrency(after)}</span></span></div>
                      </div>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={!!busyId}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(ev) => { ev.preventDefault(); performReverse(pending.id); }}
                    disabled={!!busyId}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {busyId === pending.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    Reverse credit
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            );
          })()}
          {pending?.kind === "void" && (() => {
            const after = balance - pending.amount;
            return (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>Void this credit entry?</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-2 text-sm">
                      <p>
                        A reversal row will be added that offsets this entry. The original stays in the ledger for
                        audit.
                      </p>
                      <div className="rounded border bg-muted/30 p-2 space-y-1 font-mono text-xs">
                        {pending.reference && (
                          <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span>{pending.reference}</span></div>
                        )}
                        <div className="flex justify-between"><span className="text-muted-foreground">Entry amount</span><span className={pending.amount >= 0 ? "text-emerald-500" : "text-orange-400"}>{pending.amount >= 0 ? "+" : ""}{formatCurrency(pending.amount)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Vendor balance</span><span>{formatCurrency(balance)} → <span className={after < 0 ? "text-destructive" : ""}>{formatCurrency(after)}</span></span></div>
                      </div>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={!!busyId}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(ev) => { ev.preventDefault(); performVoid(pending.id); }}
                    disabled={!!busyId}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    {busyId === pending.id ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    Void entry
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            );
          })()}
        </AlertDialogContent>
      </AlertDialog>
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
        title={`Available credit: ${formatCurrency(balance)} — click for ledger`}
      >
        <Wallet className="h-2.5 w-2.5" />
        Available credit: {formatCurrency(balance)}
      </button>
      <VendorCreditDrawer vendor={vendor} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Bulk balance map — keyed by canonical vendor_id (via alias map) so a
 * "Smith Sport Optics" invoice resolves to the same balance as "Smith Optics".
 */
export function useVendorCreditBalanceMap() {
  const { data: balances } = useQuery({
    queryKey: ["vendor_credit_balances"],
    queryFn: fetchAllVendorCreditBalances,
  });
  const { data: aliasMap } = useQuery({
    queryKey: ["vendor_alias_map"],
    queryFn: fetchVendorAliasMap,
  });
  return (vendor: string) => {
    if (!vendor || !balances) return 0;
    const map = aliasMap ?? new Map();
    const key = resolveVendorKey(vendor, map);
    return balances.find(r => r.vendor_key === key)?.balance ?? 0;
  };
}
