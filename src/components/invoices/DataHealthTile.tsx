import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, RefreshCw, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle, AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Finding {
  check: string;
  severity: "ok" | "warn" | "critical";
  count: number;
  description: string;
  sample?: any[];
}

interface HealthRun {
  id: string;
  ran_at: string;
  severity: "ok" | "warn" | "critical";
  summary: { total_findings: number; critical: number; warn: number; checks_run: number };
  findings: Finding[];
}

export function DataHealthTile() {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);

  const { data: run, refetch, isLoading } = useQuery({
    queryKey: ["data_health_latest"],
    queryFn: async (): Promise<HealthRun | null> => {
      const { data, error } = await supabase
        .from("data_health_runs")
        .select("*")
        .order("ran_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
    staleTime: 60_000,
  });

  const runScan = async () => {
    setRunning(true);
    try {
      const { error } = await supabase.functions.invoke("data-health-scan");
      if (error) throw error;
      toast.success("Data health scan complete");
      await refetch();
      setExpanded(true);
    } catch (e: any) {
      toast.error(e.message || "Scan failed");
    } finally {
      setRunning(false);
    }
  };

  if (isLoading) return null;

  const issues = run?.summary.total_findings ?? 0;
  const sev = run?.severity ?? "ok";

  const sevColor =
    sev === "critical" ? "bg-red-500/15 text-red-400 border-red-500/30"
    : sev === "warn" ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
    : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";

  const Icon = sev === "critical" ? AlertCircle : sev === "warn" ? AlertTriangle : CheckCircle2;

  return (
    <Card className={`border ${sevColor}`}>
      <div className="flex items-center justify-between p-3">
        <button onClick={() => setExpanded((e) => !e)} className="flex items-center gap-2 flex-1 text-left">
          <Activity className="h-4 w-4" />
          <span className="text-sm font-semibold">Data Health</span>
          <Badge variant="outline" className={`gap-1 ${sevColor}`}>
            <Icon className="h-3 w-3" />
            {issues === 0 ? "All clear" : `${issues} issue${issues === 1 ? "" : "s"}`}
          </Badge>
          {run && (
            <span className="text-[10px] text-muted-foreground">
              Last scan: {new Date(run.ran_at).toLocaleString()}
            </span>
          )}
          {expanded ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
        </button>
        <Button size="sm" variant="outline" className="h-7 text-xs ml-2" onClick={runScan} disabled={running}>
          {running ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
          Re-run
        </Button>
      </div>
      {expanded && run && (
        <div className="border-t border-border/50 p-3 space-y-2">
          {run.findings.map((f) => (
            <div key={f.check} className="flex items-start gap-2 text-xs">
              <Badge
                variant="outline"
                className={
                  f.severity === "critical" ? "bg-red-500/15 text-red-400 border-red-500/30"
                  : f.severity === "warn" ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                  : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                }
              >
                {f.count}
              </Badge>
              <div className="flex-1">
                <div className="font-mono text-[10px] text-muted-foreground">{f.check}</div>
                <div>{f.description}</div>
                {f.sample && f.sample.length > 0 && f.count > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                      Show sample ({Math.min(f.sample.length, 25)})
                    </summary>
                    <pre className="mt-1 p-2 bg-muted/30 rounded text-[10px] overflow-x-auto max-h-48">
                      {JSON.stringify(f.sample, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          ))}
          {!run.findings.length && <div className="text-xs text-muted-foreground">No checks recorded.</div>}
        </div>
      )}
    </Card>
  );
}
