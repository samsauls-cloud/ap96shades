/**
 * vendor-terms-registry.ts
 *
 * Single source of truth for all vendor payment terms.
 * Add new vendors here — never hardcode terms elsewhere.
 *
 * When adding a new vendor, also update:
 *  - KNOWN_VENDORS + VENDOR_MAP in src/lib/invoice-dedup.ts
 *  - SYSTEM_PROMPT vendor list in src/lib/reader-engine.ts
 */

export type TermsType =
  | 'eom_single'      // EOM + N days = baseline, then + N days = due (single payment)
  | 'eom_split'       // EOM = baseline, then split at offsets (multiple payments)
  | 'days_split'      // From invoice date (no EOM), split at offsets
  | 'net_single'      // From invoice date, single payment at N days
  | 'net_eom'         // Due at end of month following invoice month (single payment)
  | 'use_invoice';    // Read terms directly from the invoice's payment_terms field

export interface VendorTermsRule {
  vendor_match: string[];       // lowercase strings to match against vendor name
  terms_type: TermsType;
  offsets: number[];            // day offsets from baseline. Single = [N]. Split = [30,60,90] etc.
  eom_baseline_offset?: number; // for eom_single: days added to EOM to get baseline (default 0)
  due_offset?: number;          // for eom_single: days from baseline to due date
  description: string;          // human readable label
}

export const VENDOR_TERMS_REGISTRY: VendorTermsRule[] = [
  {
    vendor_match: ['marcolin', 'tom ford', 'guess', 'swarovski', 'montblanc'],
    terms_type: 'eom_split',
    offsets: [50, 80, 110],
    description: 'EOM 50/80/110 — 3 equal tranches',
    // NOTE: overridden to eom_single [20] when payment_terms contains "check 20" or "20 days eom"
  },
  {
    vendor_match: ['maui jim', 'maui'],
    terms_type: 'days_split',
    offsets: [60, 90, 120, 150],
    description: 'Days 60/90/120/150 — 4 equal tranches from invoice date (default; overridden by "Split Payment EOM" when present)',
  },
  {
    vendor_match: ['kering', 'gucci', 'saint laurent', 'balenciaga',
                   'bottega veneta', 'alexander mcqueen', 'cartier'],
    terms_type: 'eom_split',
    offsets: [30, 60, 90],
    description: 'EOM 30/60/90 — 3 equal tranches',
    // Kering terms are EOM-based: baseline = EOM of invoice month
  },
  {
    vendor_match: ['safilo', 'jimmy choo', 'dior', 'fendi', 'hugo boss', 'kate spade', 'liz claiborne', 'fossil'],
    terms_type: 'eom_single',
    offsets: [],
    eom_baseline_offset: 0,
    due_offset: 60,
    description: '60 Days EOM — Single payment',
  },
  {
    // Luxottica EOM +30 (standing terms — matched when invoice has EOM+30 or no explicit split)
    vendor_match: ['luxottica', 'ray-ban', 'rayban', 'oakley', 'costa',
                   'chanel', 'prada', 'versace', 'coach', 'burberry',
                   'michael kors', 'persol', 'miu miu', 'oliver peoples', 'ralph'],
    terms_type: 'eom_single',
    offsets: [],             // not used for eom_single
    eom_baseline_offset: 30, // EOM + 30 = baseline
    due_offset: 30,          // baseline + 30 = due
    description: 'EOM +30 — Single payment',
    // NOTE: overridden to eom_split [30,60,90] when payment_terms contains "30/60/90"
  },
  {
    vendor_match: ['smith optics', 'smith sport optics', 'smith'],
    terms_type: 'use_invoice',
    offsets: [],
    description: 'Read terms from invoice — no standing terms configured yet',
  },
];

/**
 * Look up the terms rule for a given vendor name (static registry only).
 * Returns null if no rule matched — caller should fall back to
 * reading payment_terms from the invoice directly.
 */
export function getVendorTermsRule(vendor: string): VendorTermsRule | null {
  const v = (vendor ?? '').toLowerCase();
  return VENDOR_TERMS_REGISTRY.find(rule =>
    rule.vendor_match.some(match => v.includes(match))
  ) ?? null;
}

/**
 * Look up terms rule with dynamic DB fallback.
 * Checks wizard-defined vendor_definitions first, then static registry.
 */
export async function getVendorTermsRuleAsync(vendor: string): Promise<VendorTermsRule | null> {
  // 1. Try dynamic (DB-defined) vendors first
  const { getDynamicVendorTermsRule } = await import('./dynamic-vendor-lookup');
  const dynamic = await getDynamicVendorTermsRule(vendor);
  if (dynamic) return dynamic;

  // 2. Fall back to static registry
  return getVendorTermsRule(vendor);
}

/** Check if a vendor is Luxottica based on the registry */
export function isLuxotticaVendor(vendor: string): boolean {
  const v = (vendor ?? '').toLowerCase();
  const luxRule = VENDOR_TERMS_REGISTRY.find(r =>
    r.vendor_match.includes('luxottica')
  );
  return luxRule?.vendor_match.some(m => v.includes(m)) ?? false;
}
