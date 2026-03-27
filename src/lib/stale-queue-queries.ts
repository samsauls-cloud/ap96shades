import { supabase } from "@/integrations/supabase/client";

export interface StaleQueueItem {
  id: string;
  triggered_by: string;
  entity_type: string;
  entity_id: string | null;
  upc: string | null;
  vendor: string | null;
  brand: string | null;
  prior_recon_run_id: string | null;
  queued_at: string;
  processed_at: string | null;
  status: string;
}

export async function fetchStaleQueue(): Promise<StaleQueueItem[]> {
  const { data, error } = await supabase
    .from("recon_stale_queue")
    .select("*")
    .eq("status", "pending")
    .order("queued_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as StaleQueueItem[];
}

export async function fetchStaleCount(): Promise<number> {
  const { count, error } = await supabase
    .from("recon_stale_queue")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) return 0;
  return count ?? 0;
}

export async function dismissStaleItem(id: string, note?: string) {
  const { error } = await supabase
    .from("recon_stale_queue")
    .update({
      status: "dismissed",
      processed_at: new Date().toISOString(),
    } as any)
    .eq("id", id);
  if (error) throw error;
}
