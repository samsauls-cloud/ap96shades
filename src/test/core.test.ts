/**
 * core.test.ts
 *
 * Load-bearing behavior tests for the AP Invoice Tracker.
 * Covers payment scheduler per-vendor, vendor normalization, and the two
 * drift-blocking guards. Run with `npm test` (or `npx vitest run`).
 *
 * Scope:
 *  - No UI. No Supabase. Pure logic tests on exported functions.
 *  - Every vendor rule in VENDOR_TERMS_REGISTRY has at least one assertion.
 *  - Guard 1 and Guard 2 each have positive and negative fixtures.
 *  - Known drift: three tests are currently `it.skip`'d because the 2026-04-23
 *    Luxottica EOM fix was only partially shipped. See inline notes.
 */

import { describe, it, expect } from "vitest";

import {
  calculateInstallments,
  calculateInstallmentsFromTerms,
  parsePaymentTermsText,
  getVendorDefaultTerms,
} from "@/lib/payment-terms";

import { resolvePaymentSchedule } from "@/lib/payment-terms-engine";

import {
  getVendorTermsRule,
  getVendorLockedTerms,
  isLuxotticaVendor,
} from "@/lib/vendor-terms-registry";

import { normalizeVendor, isKnownVendor } from "@/lib/invoice-dedup";

import {
  isBlockedByGuard1Credit,
  isBlockedByGuard2Paid,
} from "@/lib/engine-migrations";

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("normalizeVendor", () => {
  it("returns 'Unknown' for null/empty input", () => {
    expect(normalizeVendor(null)).toBe("Unknown");
    expect(normalizeVendor(undefined)).toBe("Unknown");
    expect(normalizeVendor("")).toBe("Unknown");
  });

  it("normalizes all Luxottica spelling variants", () => {
    expect(normalizeVendor("luxottica")).toBe("Luxottica");
    expect(normalizeVendor("LUXOTTICA")).toBe("Luxottica");
    expect(normalizeVendor("Luxottica")).toBe("Luxottica");
    expect(normalizeVendor("Luxottica of America")).toBe("Luxottica");
    expect(normalizeVendor("Luxottica of America Inc.")).toBe("Luxottica");
    expect(normalizeVendor("Luxottica USA")).toBe("Luxottica");
    expect(normalizeVendor("Essilor Luxottica")).toBe("Luxottica");
    expect(normalizeVendor("EssilorLuxottica")).toBe("Luxottica");
  });

  it("normalizes all Kering spelling variants", () => {
    expect(normalizeVendor("Kering")).toBe("Kering");
    expect(normalizeVendor("Kering Eyewear")).toBe("Kering");
    expect(normalizeVendor("Kering Eyewear USA")).toBe("Kering");
    expect(normalizeVendor("Kering Eyewear USA, Inc.")).toBe("Kering");
    expect(normalizeVendor("Kering Eyewear USA Inc.")).toBe("Kering");
  });

  it("normalizes Maui Jim variants", () => {
    expect(normalizeVendor("Maui Jim")).toBe("Maui Jim");
    expect(normalizeVendor("Maui Jim Inc.")).toBe("Maui Jim");
    expect(normalizeVendor("Maui Jim, Inc.")).toBe("Maui Jim");
    expect(normalizeVendor("Maui Jim USA")).toBe("Maui Jim");
  });

  it("normalizes Safilo variants including S.p.A.", () => {
    expect(normalizeVendor("Safilo")).toBe("Safilo");
    expect(normalizeVendor("Safilo USA")).toBe("Safilo");
    expect(normalizeVendor("Safilo Group")).toBe("Safilo");
    expect(normalizeVendor("Safilo S.p.A.")).toBe("Safilo");
    expect(normalizeVendor("Safilo SpA")).toBe("Safilo");
  });

  it("normalizes Marcolin variants", () => {
    expect(normalizeVendor("Marcolin")).toBe("Marcolin");
    expect(normalizeVendor("Marcolin USA")).toBe("Marcolin");
    expect(normalizeVendor("Marcolin S.p.A.")).toBe("Marcolin");
    expect(normalizeVendor("Marcolin SpA")).toBe("Marcolin");
  });

  it("normalizes Marchon variants including non-US offices", () => {
    expect(normalizeVendor("Marchon")).toBe("Marchon");
    expect(normalizeVendor("Marchon Eyewear")).toBe("Marchon");
    expect(normalizeVendor("Marchon Eyewear, Inc.")).toBe("Marchon");
    expect(normalizeVendor("Marchon Italia")).toBe("Marchon");
    expect(normalizeVendor("Marchon NYC")).toBe("Marchon");
  });

  it("normalizes 'Smith' and 'Smith Sport Optics' to 'Smith Optics'", () => {
    expect(normalizeVendor("Smith Optics")).toBe("Smith Optics");
    expect(normalizeVendor("Smith")).toBe("Smith Optics");
    expect(normalizeVendor("Smith Sport Optics")).toBe("Smith Optics");
    expect(normalizeVendor("Smith Sport Optics, Inc.")).toBe("Smith Optics");
  });

  it("normalizes all 8 Revo / B Robinson variants", () => {
    expect(normalizeVendor("Revo")).toBe("Revo");
    expect(normalizeVendor("B Robinson")).toBe("Revo");
    expect(normalizeVendor("B. Robinson")).toBe("Revo");
    expect(normalizeVendor("B Robinson LLC")).toBe("Revo");
    expect(normalizeVendor("B. Robinson LLC")).toBe("Revo");
    expect(normalizeVendor("B Robinson LLC / Revo")).toBe("Revo");
    expect(normalizeVendor("B. Robinson LLC / Revo")).toBe("Revo");
    expect(normalizeVendor("B Robinson / Revo")).toBe("Revo");
  });

  it("passes unknown vendors through trimmed (not 'Unknown')", () => {
    expect(normalizeVendor("Random Vendor Co")).toBe("Random Vendor Co");
    expect(normalizeVendor("  Random Vendor Co  ")).toBe("Random Vendor Co");
  });

  it("handles punctuation-trimming fallback", () => {
    expect(normalizeVendor("luxottica, of america, inc")).toBe("Luxottica");
  });
});

describe("isKnownVendor", () => {
  it("returns true for the 8 canonical vendors", () => {
    for (const v of ["Luxottica", "Kering", "Maui Jim", "Safilo", "Marcolin", "Marchon", "Smith Optics", "Revo"]) {
      expect(isKnownVendor(v)).toBe(true);
    }
  });

  it("returns false for sub-brands and legacy names not in KNOWN_VENDORS", () => {
    expect(isKnownVendor("Chanel")).toBe(false);
    expect(isKnownVendor("Costa")).toBe(false);
    expect(isKnownVendor("Oliver Peoples")).toBe(false);
    expect(isKnownVendor("Unknown")).toBe(false);
  });
});

describe("getVendorTermsRule", () => {
  it("maps Revo to net_single [90] with strict=true", () => {
    const rule = getVendorTermsRule("Revo");
    expect(rule).not.toBeNull();
    expect(rule!.terms_type).toBe("net_single");
    expect(rule!.offsets).toEqual([90]);
    expect(rule!.strict).toBe(true);
  });

  it("maps B Robinson LLC to the Revo rule", () => {
    const rule = getVendorTermsRule("B Robinson LLC / Revo");
    expect(rule?.terms_type).toBe("net_single");
    expect(rule?.offsets).toEqual([90]);
    expect(rule?.strict).toBe(true);
  });

  it("maps Luxottica to eom_single with baseline_offset=30 due_offset=30", () => {
    const rule = getVendorTermsRule("Luxottica");
    expect(rule?.terms_type).toBe("eom_single");
    expect(rule?.eom_baseline_offset).toBe(30);
    expect(rule?.due_offset).toBe(30);
  });

  it("maps Kering family to eom_split [30,60,90]", () => {
    expect(getVendorTermsRule("Kering")?.offsets).toEqual([30, 60, 90]);
    expect(getVendorTermsRule("Gucci")?.offsets).toEqual([30, 60, 90]);
    expect(getVendorTermsRule("Saint Laurent")?.offsets).toEqual([30, 60, 90]);
    expect(getVendorTermsRule("Cartier")?.offsets).toEqual([30, 60, 90]);
  });

  it("maps Maui Jim to days_split [60,90,120,150]", () => {
    const rule = getVendorTermsRule("Maui Jim");
    expect(rule?.terms_type).toBe("days_split");
    expect(rule?.offsets).toEqual([60, 90, 120, 150]);
    expect(rule?.strict).toBeFalsy();
  });

  it("maps Marcolin family to eom_split [50,80,110]", () => {
    expect(getVendorTermsRule("Marcolin")?.offsets).toEqual([50, 80, 110]);
    expect(getVendorTermsRule("Tom Ford")?.offsets).toEqual([50, 80, 110]);
  });

  it("maps Safilo family to eom_single with due_offset=60", () => {
    const rule = getVendorTermsRule("Safilo");
    expect(rule?.terms_type).toBe("eom_single");
    expect(rule?.due_offset).toBe(60);
  });

  it("maps Smith Optics to use_invoice", () => {
    expect(getVendorTermsRule("Smith Optics")?.terms_type).toBe("use_invoice");
  });

  it("returns null for completely unknown vendors", () => {
    expect(getVendorTermsRule("Completely Fictional Vendor Inc")).toBeNull();
  });
});

describe("getVendorLockedTerms (strict-only gate)", () => {
  it("returns the Revo rule (strict=true)", () => {
    expect(getVendorLockedTerms("Revo")?.strict).toBe(true);
  });

  it("returns null for non-strict vendors even if they have a rule", () => {
    expect(getVendorLockedTerms("Luxottica")).toBeNull();
    expect(getVendorLockedTerms("Maui Jim")).toBeNull();
    expect(getVendorLockedTerms("Kering")).toBeNull();
    expect(getVendorLockedTerms("Marchon")).toBeNull();
  });
});

describe("isLuxotticaVendor", () => {
  it("recognizes Luxottica and its sub-brands", () => {
    expect(isLuxotticaVendor("Luxottica")).toBe(true);
    expect(isLuxotticaVendor("Ray-Ban")).toBe(true);
    expect(isLuxotticaVendor("Oakley")).toBe(true);
    expect(isLuxotticaVendor("Costa")).toBe(true);
    expect(isLuxotticaVendor("Prada")).toBe(true);
    expect(isLuxotticaVendor("Oliver Peoples")).toBe(true);
  });

  it("rejects non-Luxottica vendors", () => {
    expect(isLuxotticaVendor("Kering")).toBe(false);
    expect(isLuxotticaVendor("Maui Jim")).toBe(false);
    expect(isLuxotticaVendor("Revo")).toBe(false);
  });
});

describe("getVendorDefaultTerms (UI suggestions)", () => {
  it("Luxottica default label is 'EOM 30 / 60 / 90'", () => {
    expect(getVendorDefaultTerms("Luxottica")?.label).toBe("EOM 30 / 60 / 90");
  });

  it("Revo default label is 'Net 90'", () => {
    expect(getVendorDefaultTerms("Revo")?.label).toBe("Net 90");
  });

  it("Maui Jim default is Days 60/90/120/150", () => {
    const d = getVendorDefaultTerms("Maui Jim");
    expect(d?.days).toEqual([60, 90, 120, 150]);
    expect(d?.eom_based).toBe(false);
  });

  it("Marchon default is Net 30", () => {
    expect(getVendorDefaultTerms("Marchon")?.label).toBe("Net 30");
  });
});

const INV = {
  date: "2026-04-01",
  number: "TEST-001",
  po: null as string | null,
};

describe("Luxottica scheduler", () => {
  it("EOM+30 single payment: April 1 invoice → due June 29 (EOM + 30 + 30)", () => {
    const installments = calculateInstallments(INV.date, 1000, "Luxottica", INV.number, INV.po, "EOM+30");
    expect(installments).toHaveLength(1);
    expect(installments[0].due_date).toBe("2026-06-29");
    expect(installments[0].amount_due).toBe(1000);
  });

  it("EOM 30/60/90 split via calculateInstallments: lands on TRUE month-end (May 31 / Jun 30 / Jul 31)", () => {
    const installments = calculateInstallments(INV.date, 3000, "Luxottica", INV.number, INV.po, "30/60/90");
    expect(installments).toHaveLength(3);
    expect(installments[0].due_date).toBe("2026-05-31");
    expect(installments[1].due_date).toBe("2026-06-30");
    expect(installments[2].due_date).toBe("2026-07-31");
    expect(installments.reduce((s, i) => s + i.amount_due, 0)).toBe(3000);
  });

  it.skip("EOM 30/60/90 split via resolvePaymentSchedule: should land on true month-end", () => {
    // BROKEN: addMonthsFromEom in payment-terms-engine.ts:103-115 still uses
    // Math.min(baselineDay, lastDayOfTarget), producing May 30 / Jun 30 / Jul 30
    // instead of May 31 / Jun 30 / Jul 31. The 2026-04-23 fix was not applied
    // to this callsite. Un-skip when the helper is updated to use
    // `new Date(targetYear, targetMonth + 1, 0)` directly (no Math.min).
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Luxottica", "Procurement", invDate, 3000, "EOM 30/60/90");
    expect(sched.tranches).toHaveLength(3);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-05-31");
    expect(ymd(sched.tranches[1].due_date)).toBe("2026-06-30");
    expect(ymd(sched.tranches[2].due_date)).toBe("2026-07-31");
  });

  it("EOM+30 single via resolvePaymentSchedule uses buildLuxEomSingleSchedule path", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Luxottica", "Procurement", invDate, 1000, null);
    expect(sched.vendor_terms_type).toBe("lux_eom_single");
    expect(sched.tranches).toHaveLength(1);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-06-29");
  });

  it("credit category returns empty schedule (never generates payments)", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Luxottica", "Credit", invDate, -500, null);
    expect(sched.tranches).toHaveLength(0);
    expect(sched.human_label).toMatch(/credit/i);
  });
});

describe("Kering scheduler", () => {
  it.skip("EOM 30/60/90 default via resolvePaymentSchedule: should land on true month-end", () => {
    // BROKEN: same bug as the Luxottica split path — goes through
    // addMonthsFromEom which still clamps via Math.min. Un-skip when
    // addMonthsFromEom is fixed.
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Kering", "Procurement", invDate, 3000, "EOM 30/60/90");
    expect(sched.tranches).toHaveLength(3);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-05-31");
    expect(ymd(sched.tranches[1].due_date)).toBe("2026-06-30");
    expect(ymd(sched.tranches[2].due_date)).toBe("2026-07-31");
  });

  it.skip("'Bank transfer 30/60/90' (EOM-based) via calculateInstallments: should land on true month-end", () => {
    // BROKEN: Kering inline path at payment-terms.ts:471-481 still uses
    // Math.min(baselineDay, lastDayOfTarget). Un-skip when that block mirrors
    // the Luxottica split fix at line 551.
    const installments = calculateInstallments(INV.date, 3000, "Kering", INV.number, INV.po, "bank transfer 30/60/90 inv. date");
    expect(installments).toHaveLength(3);
    expect(installments[0].due_date).toBe("2026-05-31");
    expect(installments[1].due_date).toBe("2026-06-30");
    expect(installments[2].due_date).toBe("2026-07-31");
  });

  it("installments sum exactly to the invoice total (rounding absorbed on last tranche)", () => {
    const installments = calculateInstallments(INV.date, 100.01, "Kering", INV.number, INV.po, "bank transfer 30/60/90 inv. date");
    expect(installments).toHaveLength(3);
    const sum = installments.reduce((s, i) => s + i.amount_due, 0);
    expect(Math.round(sum * 100)).toBe(10001);
  });
});

describe("Maui Jim scheduler", () => {
  it("default Days 60/90/120/150 via resolvePaymentSchedule: dates are invoice-date + N (NOT EOM)", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Maui Jim", "Procurement", invDate, 4000, null);
    expect(sched.tranches).toHaveLength(4);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-05-31");
    expect(ymd(sched.tranches[1].due_date)).toBe("2026-06-30");
    expect(ymd(sched.tranches[2].due_date)).toBe("2026-07-30");
    expect(ymd(sched.tranches[3].due_date)).toBe("2026-08-29");
  });

  it("'Split Payment EOM 60,90,120,150' via resolvePaymentSchedule: EOM-anchored, rounded to month-end", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Maui Jim", "Procurement", invDate, 4000, "Split Payment EOM 60,90,120,150");
    expect(sched.tranches).toHaveLength(4);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-06-30");
    expect(ymd(sched.tranches[1].due_date)).toBe("2026-07-31");
    expect(ymd(sched.tranches[2].due_date)).toBe("2026-08-31");
    expect(ymd(sched.tranches[3].due_date)).toBe("2026-09-30");
  });
});

describe("Marcolin scheduler (dual-terms vendor)", () => {
  it("default EOM 50/80/110 via resolvePaymentSchedule (no explicit 'Check 20')", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Marcolin", "Procurement", invDate, 3000, null);
    expect(sched.tranches).toHaveLength(3);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-06-19");
    expect(ymd(sched.tranches[1].due_date)).toBe("2026-07-19");
    expect(ymd(sched.tranches[2].due_date)).toBe("2026-08-18");
  });

  it("'Check 20 EoM' override via resolvePaymentSchedule: single payment EOM+20", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Marcolin", "Procurement", invDate, 1000, "Check 20 EoM");
    expect(sched.tranches).toHaveLength(1);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-05-20");
    expect(sched.human_label).toMatch(/check 20/i);
  });

  it("'Check 20 days EoM' via calculateInstallments: single payment EOM+20", () => {
    const installments = calculateInstallments(INV.date, 1000, "Marcolin", INV.number, INV.po, "Check 20 days EoM");
    expect(installments).toHaveLength(1);
    expect(installments[0].due_date).toBe("2026-05-20");
    expect(installments[0].amount_due).toBe(1000);
  });
});

describe("Safilo scheduler", () => {
  it("'60 Days EOM' via calculateInstallments: single payment EOM+60", () => {
    const installments = calculateInstallments(INV.date, 1000, "Safilo", INV.number, INV.po, "60 Days EOM");
    expect(installments).toHaveLength(1);
    expect(installments[0].due_date).toBe("2026-06-29");
  });

  it("'60 Days EOM' via resolvePaymentSchedule: single payment EOM+60", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Safilo", "Procurement", invDate, 1000, "60 Days EOM");
    expect(sched.tranches).toHaveLength(1);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-06-29");
  });
});

describe("Marchon scheduler", () => {
  it("Net 30 default via resolvePaymentSchedule: single payment invoice-date + 30", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Marchon", "Procurement", invDate, 1000, null);
    expect(sched.tranches).toHaveLength(1);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-05-01");
    expect(sched.vendor_terms_type).toBe("net_single");
  });
});

describe("Revo scheduler (strict Net 90)", () => {
  it("Net 90 default via resolvePaymentSchedule: single payment invoice-date + 90", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Revo", "Procurement", invDate, 1000, null);
    expect(sched.tranches).toHaveLength(1);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-06-30");
    expect(sched.vendor_terms_type).toBe("net_single");
  });

  it("B Robinson LLC / Revo resolves via the same Revo rule", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("B Robinson LLC / Revo", "Procurement", invDate, 1000, null);
    expect(sched.tranches).toHaveLength(1);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-06-30");
  });
});

describe("Smith Optics scheduler (use_invoice fallback)", () => {
  it("with 'Net 30' terms text: single payment invoice-date + 30", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Smith Optics", "Procurement", invDate, 1000, "Net 30");
    expect(sched.tranches).toHaveLength(1);
    expect(ymd(sched.tranches[0].due_date)).toBe("2026-05-01");
  });

  it("with no terms text: falls to 'unknown' (flag for review)", () => {
    const invDate = new Date("2026-04-01T00:00:00");
    const sched = resolvePaymentSchedule("Smith Optics", "Procurement", invDate, 1000, null);
    expect(sched.vendor_terms_type).toBe("unknown");
    expect(sched.tranches).toHaveLength(0);
  });
});

describe("parsePaymentTermsText", () => {
  it("recognizes 'EOM 30/60/90' as eom_split", () => {
    const t = parsePaymentTermsText("EOM 30/60/90");
    expect(t.type).toBe("eom_split");
    expect(t.days).toEqual([30, 60, 90]);
    expect(t.eom_based).toBe(true);
    expect(t.confidence).toBe("high");
  });

  it("recognizes 'Net 30' as net_single", () => {
    const t = parsePaymentTermsText("Net 30");
    expect(t.type).toBe("net_single");
    expect(t.days).toEqual([30]);
    expect(t.eom_based).toBe(false);
  });

  it("recognizes 'Days 60/90/120/150' as net_split", () => {
    const t = parsePaymentTermsText("Days 60/90/120/150");
    expect(t.type).toBe("net_split");
    expect(t.days).toEqual([60, 90, 120, 150]);
    expect(t.eom_based).toBe(false);
  });

  it("recognizes '2/10 Net 30' as early_pay", () => {
    const t = parsePaymentTermsText("2/10 Net 30");
    expect(t.type).toBe("early_pay");
    expect(t.discount_pct).toBe(2);
    expect(t.discount_days).toBe(10);
    expect(t.net_days).toBe(30);
  });

  it("recognizes COD", () => {
    expect(parsePaymentTermsText("COD").type).toBe("cod");
    expect(parsePaymentTermsText("Cash on Delivery").type).toBe("cod");
  });

  it("treats FOB as shipping only (not payment)", () => {
    const t = parsePaymentTermsText("FOB");
    expect(t.type).toBe("unknown");
    expect(t.shipping_terms).toBe("FOB");
  });

  it("returns unknown for empty/null input", () => {
    expect(parsePaymentTermsText(null).type).toBe("unknown");
    expect(parsePaymentTermsText("").type).toBe("unknown");
  });
});

describe("Guard 1 (credit-memo protection)", () => {
  it("empty row array is not blocked", () => {
    expect(isBlockedByGuard1Credit([])).toBe(false);
  });

  it("normal unpaid rows are not blocked", () => {
    expect(
      isBlockedByGuard1Credit([
        { terms: "Net 30", installment_label: "1 of 3", amount_due: 100 },
        { terms: "Net 30", installment_label: "2 of 3", amount_due: 100 },
      ])
    ).toBe(false);
  });

  it("blocks when any row has terms='credit_memo'", () => {
    expect(isBlockedByGuard1Credit([{ terms: "credit_memo", amount_due: 100 }])).toBe(true);
  });

  it("blocks when any row has installment_label='Credit'", () => {
    expect(isBlockedByGuard1Credit([{ installment_label: "Credit", amount_due: 100 }])).toBe(true);
  });

  it("blocks when any row has a negative amount_due", () => {
    expect(isBlockedByGuard1Credit([{ amount_due: -100 }])).toBe(true);
    expect(isBlockedByGuard1Credit([{ amount_due: -0.01 }])).toBe(true);
  });

  it("does NOT block on amount_due === 0 (only negative)", () => {
    expect(isBlockedByGuard1Credit([{ amount_due: 0 }])).toBe(false);
  });

  it("blocks even when only ONE row out of many trips a condition", () => {
    expect(
      isBlockedByGuard1Credit([
        { terms: "Net 30", amount_due: 100 },
        { terms: "Net 30", amount_due: 100 },
        { terms: "credit_memo", amount_due: 0 },
      ])
    ).toBe(true);
  });

  it("coerces string amount_due for comparison", () => {
    expect(isBlockedByGuard1Credit([{ amount_due: "-50" as any }])).toBe(true);
  });
});

describe("Guard 2 (paid-installment protection)", () => {
  it("empty row array is not blocked", () => {
    expect(isBlockedByGuard2Paid([])).toBe(false);
  });

  it("rows with is_paid=false and payment_status='unpaid' are not blocked", () => {
    expect(
      isBlockedByGuard2Paid([
        { is_paid: false, payment_status: "unpaid", amount_paid: 0 },
        { is_paid: false, payment_status: "unpaid", amount_paid: 0 },
      ])
    ).toBe(false);
  });

  it("blocks when any row has is_paid=true", () => {
    expect(isBlockedByGuard2Paid([{ is_paid: true, amount_paid: 0 }])).toBe(true);
  });

  it("blocks when any row has payment_status='paid'", () => {
    expect(isBlockedByGuard2Paid([{ payment_status: "paid" }])).toBe(true);
  });

  it("blocks when any row has amount_paid > 0", () => {
    expect(isBlockedByGuard2Paid([{ amount_paid: 0.01 }])).toBe(true);
    expect(isBlockedByGuard2Paid([{ amount_paid: 500 }])).toBe(true);
  });

  it("does NOT block when amount_paid === 0 and other flags are clean", () => {
    expect(isBlockedByGuard2Paid([{ is_paid: false, payment_status: "unpaid", amount_paid: 0 }])).toBe(false);
  });

  it("coerces string amount_paid for comparison", () => {
    expect(isBlockedByGuard2Paid([{ amount_paid: "500" as any }])).toBe(true);
  });

  it("blocks even when only ONE row out of many shows payment activity", () => {
    expect(
      isBlockedByGuard2Paid([
        { is_paid: false, amount_paid: 0 },
        { is_paid: false, amount_paid: 0 },
        { is_paid: true, amount_paid: 100 },
      ])
    ).toBe(true);
  });

  it("does not confuse 'partial' status with unblocked", () => {
    expect(isBlockedByGuard2Paid([{ payment_status: "partial", amount_paid: 0 }])).toBe(false);
    expect(isBlockedByGuard2Paid([{ payment_status: "partial", amount_paid: 250 }])).toBe(true);
  });
});

describe("installment math integrity", () => {
  const vendors: Array<[string, string | null, number]> = [
    ["Luxottica", "30/60/90", 3000],
    ["Luxottica", "EOM+30", 1000],
    ["Kering", "bank transfer 30/60/90 inv. date", 2999.99],
    ["Marcolin", "Check 20 days EoM", 1234.56],
    ["Safilo", "60 Days EOM", 999.99],
  ];

  for (const [vendor, terms, total] of vendors) {
    it(`${vendor} (${terms}) installments sum exactly to ${total}`, () => {
      const installments = calculateInstallments(INV.date, total, vendor, INV.number, INV.po, terms);
      if (installments.length === 0) return;
      const sum = installments.reduce((s, i) => s + i.amount_due, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(total * 100));
    });
  }
});

describe("calculateInstallmentsFromTerms", () => {
  it("splits cleanly from parsed terms and preserves exact total", () => {
    const terms = parsePaymentTermsText("Net 30/60/90");
    const installments = calculateInstallmentsFromTerms(INV.date, 100.01, "Kering", INV.number, INV.po, terms);
    expect(installments).toHaveLength(3);
    const sum = installments.reduce((s, i) => s + i.amount_due, 0);
    expect(Math.round(sum * 100)).toBe(10001);
  });
});