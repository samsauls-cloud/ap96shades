import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Wallet } from "lucide-react";
import { fetchVendorCreditBalance, fetchVendorCreditLedger, type VendorCredit } from "@/lib/vendor-credits";
import { formatCurrency } from "@/lib/supabase-queries";
import { useNavigate } from "react-router-dom";
import { AddVendorCreditDialog } from "@/components/invoices/AddVendorCreditDialog";

interface Props {
  vendor: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SOURCE_LABEL: Record<string, string> = {
  remittance_overpay: "Remittance overpay",
  invoice_application: "Applied to invoice",
  manual_adjustment: "Manual adjustment",
  reversal: "Reversal",
};

export function VendorCreditDrawer({ vendor, open, onOpenChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState(0);
  const [entries, setEntries] = useState<VendorCredit[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open || !vendor) return;
    setLoading(true);
    Promise.all([fetchVendorCreditBalance(vendor), fetchVendorCreditLedger(vendor)])
      .then(([bal, ledger]) => {
        setBalance(bal);
        setEntries(ledger);
      })
      .finally(() => setLoading(false));
  }, [open, vendor]);

  // Build running balance oldest → newest, then reverse for display.
  const oldestFirst = [...entries].reverse();
  let running = 0;
  const withRunning = oldestFirst.map(e => {
    running += Number(e.amount);
    return { ...e, runningBalance: running };
  }).reverse();

  const lastActivity = entries[0]?.occurred_on ?? null;

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
        </SheetHeader>

        <div className="mt-4">
          {loading ? (
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
                return (
                  <div
                    key={e.id}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={() => {
                      if (clickable) navigate(`/invoices?open=${e.related_invoice_id}`);
                    }}
                    className={`p-2.5 rounded border text-xs space-y-0.5 ${
                      clickable ? "cursor-pointer hover:bg-muted/40 transition-colors" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono">{e.occurred_on}</span>
                          <Badge variant="outline" className="text-[10px] h-4 px-1">
                            {SOURCE_LABEL[e.source_type] ?? e.source_type}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-muted-foreground truncate">{e.description}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`font-bold tabular-nums ${isPositive ? "text-emerald-500" : "text-orange-400"}`}>
                          {isPositive ? "+" : ""}{formatCurrency(e.amount)}
                        </p>
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          bal {formatCurrency(e.runningBalance)}
                        </p>
                      </div>
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

/**
 * Inline pill that opens the ledger drawer when clicked. Hides when balance ≤ 0.
 * Pass `balance` from a parent bulk-fetch to avoid N queries in lists.
 */
export function VendorCreditBadge({ vendor, balance: providedBalance }: { vendor: string; balance?: number }) {
  const [balance, setBalance] = useState<number | null>(providedBalance ?? null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (providedBalance !== undefined) {
      setBalance(providedBalance);
      return;
    }
    let active = true;
    fetchVendorCreditBalance(vendor).then(b => {
      if (active) setBalance(b);
    });
    return () => { active = false; };
  }, [vendor, providedBalance]);

  if (balance === null || balance <= 0) return null;

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

/** React-Query-free bulk balance lookup map for use in table headers/rows. */
export function useVendorCreditBalanceMap() {
  const [map, setMap] = useState<Record<string, number>>({});
  useEffect(() => {
    let active = true;
    import("@/lib/vendor-credits").then(({ fetchAllVendorCreditBalances }) => {
      fetchAllVendorCreditBalances().then(rows => {
        if (!active) return;
        const m: Record<string, number> = {};
        for (const r of rows) m[r.vendor_key] = r.balance;
        setMap(m);
      });
    });
    return () => { active = false; };
  }, []);
  return (vendor: string) => map[vendor?.toLowerCase()] ?? 0;
}
