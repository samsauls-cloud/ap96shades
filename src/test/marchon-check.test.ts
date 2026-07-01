import { describe, it, expect } from "vitest";
import { calculateInstallments, parsePaymentTermsText } from "@/lib/payment-terms";
import { resolvePaymentSchedule } from "@/lib/payment-terms-engine";
import { parseTermDayMarkers } from "@/lib/invoice-preflight";

describe("Marchon US 30/60/90/120", () => {
  it("parses 4", () => {
    const t = parsePaymentTermsText("US 30/60/90/120");
    expect(t.days.length).toBe(4);
    expect(t.installments).toBe(4);
  });
  it("calculateInstallments returns 4", () => {
    const s = calculateInstallments("2026-06-25", 5211.21, "Marchon", "9640208183", null, "US 30/60/90/120", null);
    console.log("calc:", s.length, s.map(x=>x.installment_label));
    expect(s.length).toBe(4);
  });
  it("resolvePaymentSchedule returns 4", () => {
    const r = resolvePaymentSchedule("Marchon", "Procurement", new Date("2026-06-25"), 5211.21, "US 30/60/90/120");
    console.log("resolve:", r.tranches.length);
    expect(r.tranches.length).toBe(4);
  });
  it("markers = 4", () => {
    expect(parseTermDayMarkers("US 30/60/90/120").length).toBe(4);
  });
});
