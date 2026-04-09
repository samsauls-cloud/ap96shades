/**
 * dynamic-vendor-lookup.ts
 *
 * Fetches wizard-defined vendor definitions and term rules from the database.
 * Used by the import pipeline to auto-apply terms for vendors onboarded
 * via the "Define New Vendor" wizard.
 *
 * Results are cached in memory for the duration of a batch import session.
 */

import { supabase } from "@/integrations/supabase/client";
import type { VendorTermsRule, TermsType } from "./vendor-terms-registry";

// ── Cache ──────────────────────────────────────────────────────────────────

interface CachedVendorDef {
  id: string;
  vendor_name: string;
  vendor_key: string;
  customer_number: string | null;
}

interface CachedTermDef {
  vendor_id: string;
  term_label: string | null;
  term_type: string;
  payment_count: number;
  offset_type: string;
  day_intervals: number[];
  is_default: boolean;
}

interface DynamicVendorCache {
  definitions: CachedVendorDef[];
  terms: CachedTermDef[];
  aliases: { vendor_name: string; vendor_id: string; aliases: string[] }[];
  loadedAt: number;
}

let cache: DynamicVendorCache | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

/** Force-clear the cache (call between batch sessions if needed) */
export function clearDynamicVendorCache() {
  cache = null;
}

async function ensureCache(): Promise<DynamicVendorCache> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;

  const [defRes, termRes, aliasRes] = await Promise.all([
    supabase.from("vendor_definitions").select("id, vendor_name, vendor_key, customer_number"),
    supabase.from("vendor_term_definitions").select("vendor_id, term_label, term_type, payment_count, offset_type, day_intervals, is_default"),
    supabase.from("vendor_alias_map").select("vendor_name, vendor_id, aliases"),
  ]);

  cache = {
    definitions: (defRes.data ?? []) as CachedVendorDef[],
    terms: (termRes.data ?? []) as CachedTermDef[],
    aliases: (aliasRes.data ?? []) as { vendor_name: string; vendor_id: string; aliases: string[] }[],
    loadedAt: Date.now(),
  };
  return cache;
}

// ── Vendor name resolution ─────────────────────────────────────────────────

/**
 * Try to resolve a raw vendor string to a canonical name using
 * wizard-defined aliases in vendor_alias_map.
 * Returns null if no match found — caller should fall back to static map.
 */
export async function resolveDynamicVendorName(rawVendor: string): Promise<string | null> {
  if (!rawVendor) return null;
  const c = await ensureCache();
  const lower = rawVendor.toLowerCase().trim();
  const stripped = lower.replace(/[.,]/g, "").replace(/\s+/g, " ").trim();

  for (const alias of c.aliases) {
    // Check against aliases array
    if (alias.aliases.some(a => a.toLowerCase() === lower || a.toLowerCase() === stripped)) {
      return alias.vendor_name;
    }
    // Also check vendor_id (which is the vendor_key)
    if (alias.vendor_id === stripped || alias.vendor_id === lower) {
      return alias.vendor_name;
    }
  }

  // Also check vendor_definitions.vendor_key directly
  const keyMatch = c.definitions.find(d =>
    d.vendor_key === stripped ||
    d.vendor_key === lower.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
  );
  if (keyMatch) return keyMatch.vendor_name;

  return null;
}

// ── Terms rule resolution ──────────────────────────────────────────────────

/**
 * Look up a dynamic VendorTermsRule for a given vendor name.
 * Returns null if no wizard-defined rule exists — caller falls back to static registry.
 */
export async function getDynamicVendorTermsRule(vendor: string): Promise<VendorTermsRule | null> {
  if (!vendor) return null;
  const c = await ensureCache();
  const lower = vendor.toLowerCase().trim();
  const vendorKey = lower.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  // Find matching vendor definition
  const def = c.definitions.find(d =>
    d.vendor_key === vendorKey ||
    d.vendor_name.toLowerCase() === lower
  );
  if (!def) return null;

  // Find default term definition for this vendor
  const term = c.terms.find(t => t.vendor_id === def.id && t.is_default);
  if (!term) return null;

  // Map DB offset_type to TermsType
  let termsType: TermsType;
  const dbType = term.term_type;
  if (dbType === "eom_split") termsType = "eom_split";
  else if (dbType === "eom_single") termsType = "eom_single";
  else if (dbType === "days_split") termsType = "days_split";
  else if (dbType === "net_single") termsType = "net_single";
  else if (dbType === "net_eom") termsType = "net_eom";
  else termsType = "use_invoice";

  const isEom = term.offset_type === "from_eom";

  return {
    vendor_match: [vendorKey, lower],
    terms_type: termsType,
    offsets: term.day_intervals ?? [],
    eom_baseline_offset: isEom ? 0 : undefined,
    due_offset: termsType === "eom_single" ? (term.day_intervals[0] ?? 30) : undefined,
    description: term.term_label || `${termsType} ${(term.day_intervals ?? []).join("/")}`,
  };
}
