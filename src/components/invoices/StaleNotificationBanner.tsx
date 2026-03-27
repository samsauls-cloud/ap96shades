import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchStaleCount } from "@/lib/stale-queue-queries";

export function StaleNotificationBanner() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);

  const { data: staleCount = 0 } = useQuery({
    queryKey: ["stale_count_banner"],
    queryFn: fetchStaleCount,
    refetchInterval: 30000,
  });

  // Reset dismissed state when count changes significantly
  useEffect(() => {
    if (staleCount >= 3) setDismissed(false);
  }, [staleCount]);

  if (dismissed || staleCount < 3) return null;

  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-amber-700">
        <RefreshCw className="h-4 w-4" />
        <span>
          <strong>{staleCount}</strong> new invoices or PO updates have been added since the last reconciliation run.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white"
          onClick={() => navigate("/reconciliation")}
        >
          Re-Reconcile Stale Records
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-amber-700 hover:text-amber-900"
          onClick={() => setDismissed(true)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
