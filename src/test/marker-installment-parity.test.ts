/**
 * Guard test: parseTermDayMarkers(text).length MUST equal
 * resolvePaymentSchedule(...).tranches.length for any N-way printed terms.
 *
 * This prevents regressions where a vendor branch matches a substring
 * (e.g. "30/60/90" inside "30/60/90/120") and hardcodes a shorter offset list.
 */
import { describe, it, expect } from "vitest";
import { parseTermDayMarkers } from "@/lib/invoice-preflight";
import { resolvePaymentSchedule } from "@/lib/payment-terms-engine";

const CASES: Array<{ vendor: string; terms: string; expectedMarkers: number }> = [
  { vendor: "Acme Generic",          terms: "30/60/90/120",                            expectedMarkers: 4 },
  { vendor: "Acme Generic",          terms: "30/60/90",                                expectedMarkers: 3 },
  { vendor: "Acme Generic",          terms: "30/60",                                   expectedMarkers: 2 },
  { vendor: "Acme Generic",          terms: "Net 30",                                  expectedMarkers: 0 },
  { vendor: "Acme Generic",          terms: "EOM +30",                                 expectedMarkers: 0 },
  { vendor: "Kering",                terms: "Bank transfer 30/60/90/120 inv.date",     expectedMarkers: 4 },
  { vendor: "Kering",                terms: "Bank transfer 30/60/90 inv.date",         expectedMarkers: 3 },
  { vendor: "Luxottica",             terms: "30/60/90/120",                            expectedMarkers: 4 },
  { vendor: "Luxottica",             terms: "EOM 30/60/90",                            expectedMarkers: 3 },
];

describe("marker count == generated installment count", () => {
  const invoiceDate = new Date("2026-01-15T00:00:00");
  const total = 1000;

  for (const c of CASES) {
    it(`${c.vendor} — "${c.terms}"`, () => {
      const markers = parseTermDayMarkers(c.terms);
      expect(markers.length).toBe(c.expectedMarkers);

      const schedule = resolvePaymentSchedule(
        c.vendor,
        "Procurement",
        invoiceDate,
        total,
        c.terms,
      );

      // If the printed terms contain 2+ markers, the generated schedule
      // must contain EXACTLY that many tranches. (0 or 1 markers fall
      // through to single-payment branches, which is correct.)
      if (markers.length >= 2) {
        expect(schedule.tranches.length).toBe(markers.length);
      } else {
        expect(schedule.tranches.length).toBeGreaterThanOrEqual(1);
      }
    });
  }
});
