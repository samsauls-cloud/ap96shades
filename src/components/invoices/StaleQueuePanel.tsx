import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, RefreshCw, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { fetchStaleQueue, dismissStaleItem, type StaleQueueItem } from "@/lib/stale-queue-queries";
import { runTargetedReconciliation } from "@/lib/targeted-reconciliation";
import { formatDate } from "@/lib/supabase-queries";
import type { ReconciliationProgress } from "@/lib/reconciliation-engine";

interface Props {
  onRunComplete: () => void;
}

export function StaleQueuePanel({ onRunComplete }: Props) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(true);
  const [running, setRunning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ReconciliationProgress | null>(null);

  const { data: queue = [] } = useQuery({
    queryKey: ["stale_queue"],
    queryFn: fetchStaleQueue,
    refetchInterval: 15000,
  });

  if (queue.length === 0) return null;

  const handleReconAll = async () => {
    setRunning(true);
    setProgress({ step: "Starting…", detail: "Re-reconciling all stale records" });
    try {
      const result = await runTargetedReconciliation({ mode: "stale_only" }, setProgress);
      toast.success(`Re-reconciliation complete: ${result.totalDiscrepancies} discrepancies found across ${result.totalInvoices} invoices`);
      qc.invalidateQueries({ queryKey: ["stale_queue"] });
      qc.invalidateQueries({ queryKey: ["recon_discrepancies"] });
      qc.invalidateQueries({ queryKey: ["recon_runs"] });
      qc.invalidateQueries({ queryKey: ["vendor_invoices"] });
      onRunComplete();
    } catch (err: any) {
      toast.error(`Re-reconciliation failed: ${err.message}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const handleReconOne = async (item: StaleQueueItem) => {
    if (!item.entity_id) return;
    setRunningId(item.id);
    try {
      await runTargetedReconciliation({ mode: "invoice", invoice_ids: [item.entity_id] });
      toast.success("Re-reconciled successfully");
      qc.invalidateQueries({ queryKey: ["stale_queue"] });
      qc.invalidateQueries({ queryKey: ["recon_discrepancies"] });
      qc.invalidateQueries({ queryKey: ["recon_runs"] });
      onRunComplete();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setRunningId(null);
    }
  };

  const handleDismiss = async (id: string) => {
    try {
      await dismissStaleItem(id);
      toast.success("Dismissed");
      qc.invalidateQueries({ queryKey: ["stale_queue"] });
    } catch { toast.error("Failed"); }
  };

  const triggerLabel: Record<string, string> = {
    new_invoice: "New Invoice",
    invoice_updated: "Invoice Updated",
    new_po: "New PO",
    lightspeed_csv: "Lightspeed CSV",
    qty_changed: "Qty Changed",
    price_changed: "Price Changed",
    manual: "Manual",
  };

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5">
      <button
        className="w-full flex items-center justify-between p-3 text-left"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-amber-600" /> : <ChevronRight className="h-4 w-4 text-amber-600" />}
          <Zap className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-semibold text-amber-700">
            {queue.length} Record{queue.length !== 1 ? "s" : ""} Awaiting Re-Reconciliation
          </span>
        </div>
        <Button
          size="sm"
          className="h-7 text-xs gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
          disabled={running}
          onClick={(e) => { e.stopPropagation(); handleReconAll(); }}
        >
          <RefreshCw className={`h-3 w-3 ${running ? "animate-spin" : ""}`} />
          {running ? (progress?.step ?? "Running…") : `Re-Reconcile All (${queue.length})`}
        </Button>
      </button>

      {expanded && (
        <div className="border-t border-amber-500/20 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-amber-500/20 hover:bg-transparent">
                <TableHead className="text-[10px] font-semibold">Queued At</TableHead>
                <TableHead className="text-[10px] font-semibold">Trigger</TableHead>
                <TableHead className="text-[10px] font-semibold">Entity</TableHead>
                <TableHead className="text-[10px] font-semibold">UPC</TableHead>
                <TableHead className="text-[10px] font-semibold">Vendor</TableHead>
                <TableHead className="text-[10px] font-semibold">Brand</TableHead>
                <TableHead className="text-[10px] font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.slice(0, 50).map(item => (
                <TableRow key={item.id} className="border-amber-500/10">
                  <TableCell className="text-[10px]">{formatDate(item.queued_at)}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[9px] bg-amber-500/15 text-amber-700 border-amber-500/30">
                      {triggerLabel[item.triggered_by] ?? item.triggered_by}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-[10px] font-mono">{item.entity_type}</TableCell>
                  <TableCell className="text-[10px] font-mono">{item.upc ?? "—"}</TableCell>
                  <TableCell className="text-[10px]">{item.vendor ?? "—"}</TableCell>
                  <TableCell className="text-[10px]">{item.brand ?? "—"}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[9px] px-1.5"
                        disabled={runningId === item.id}
                        onClick={() => handleReconOne(item)}
                      >
                        {runningId === item.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Re-Reconcile"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[9px] px-1.5 text-muted-foreground"
                        onClick={() => handleDismiss(item.id)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {queue.length > 50 && (
            <p className="text-[10px] text-muted-foreground p-2 text-center">
              Showing 50 of {queue.length} — run re-reconciliation to process all
            </p>
          )}
        </div>
      )}
    </div>
  );
}
