/**
 * Canonical vendor-key resolution. Mirrors the SQL in vendor_credit_balances:
 * a vendor string resolves to vendor_alias_map.vendor_id if it matches the
 * canonical vendor_name or any entry in aliases[]; otherwise lower(trim(vendor)).
 */
import { supabase } from "@/integrations/supabase/client";

export interface VendorAliasRow {
  vendor_id: string;
  vendor_name: string;
  aliases: string[] | null;
}

export async function fetchVendorAliasMap(): Promise<Map<string, { vendor_id: string; vendor_name: string }>> {
  const { data, error } = await supabase
    .from("vendor_alias_map")
    .select("vendor_id, vendor_name, aliases");
  if (error) {
    console.warn("[vendor-alias-resolver] fetch failed", error);
    return new Map();
  }
  const map = new Map<string, { vendor_id: string; vendor_name: string }>();
  for (const r of (data ?? []) as VendorAliasRow[]) {
    const id = r.vendor_id;
    const name = r.vendor_name;
    if (r.vendor_name) map.set(r.vendor_name.trim().toLowerCase(), { vendor_id: id, vendor_name: name });
    for (const a of r.aliases ?? []) {
      if (a) map.set(a.trim().toLowerCase(), { vendor_id: id, vendor_name: name });
    }
  }
  return map;
}

export function resolveVendorKey(
  vendor: string,
  aliasMap: Map<string, { vendor_id: string; vendor_name: string }>,
): string {
  if (!vendor) return "";
  const k = vendor.trim().toLowerCase();
  return aliasMap.get(k)?.vendor_id ?? k;
}
