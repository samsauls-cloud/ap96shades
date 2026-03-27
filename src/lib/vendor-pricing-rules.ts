/**
 * Vendor-specific pricing rules.
 * These rules are applied post-extraction to adjust line item prices
 * when vendors have standing discount agreements not always reflected on invoices.
 */

export interface VendorPricingRule {
  vendor: string;
  discountPercent: number;
  description: string;
  applyTo: "all"; // future: could be per-brand
}

/**
 * All vendor pricing rules. Add new vendor discounts here.
 */
export const VENDOR_PRICING_RULES: VendorPricingRule[] = [
  {
    vendor: "Marchon",
    discountPercent: 10,
    description: "All Marchon frames and brands receive a 10% discount",
    applyTo: "all",
  },
];

/**
 * Look up the pricing rule for a given normalized vendor name.
 */
export function getVendorPricingRule(vendor: string): VendorPricingRule | undefined {
  return VENDOR_PRICING_RULES.find(
    (r) => r.vendor.toLowerCase() === vendor.toLowerCase()
  );
}

/**
 * Apply vendor discount to line items if a pricing rule exists.
 * Computes the discounted unit_price and line_total for each line item.
 * Returns the adjusted line items and adjusted totals.
 */
export function applyVendorDiscount(
  vendor: string,
  lineItems: any[],
  subtotal?: number | null,
  total?: number | null
): {
  lineItems: any[];
  subtotal: number | null | undefined;
  total: number | null | undefined;
  discountApplied: boolean;
  discountPercent: number;
} {
  const rule = getVendorPricingRule(vendor);
  if (!rule) {
    return { lineItems, subtotal, total, discountApplied: false, discountPercent: 0 };
  }

  const multiplier = 1 - rule.discountPercent / 100;

  const adjustedItems = lineItems.map((li) => {
    const unitPrice = li.unit_price != null ? Number(li.unit_price) : null;
    if (unitPrice == null) return li;

    // Check if discount already appears applied (price already low enough)
    // We skip re-applying if the item already has a discount note
    const adjustedUnitPrice = Math.round(unitPrice * multiplier * 100) / 100;
    const qty = li.qty_shipped ?? li.qty_ordered ?? li.qty ?? 1;
    const adjustedLineTotal = Math.round(adjustedUnitPrice * qty * 100) / 100;

    return {
      ...li,
      unit_price_before_discount: unitPrice,
      unit_price: adjustedUnitPrice,
      line_total: adjustedLineTotal,
      vendor_discount_applied: `${rule.discountPercent}%`,
    };
  });

  // Recalculate subtotal from adjusted line totals
  const adjustedSubtotal =
    subtotal != null
      ? Math.round(Number(subtotal) * multiplier * 100) / 100
      : null;

  // Recalculate total: adjusted subtotal + tax + freight (keep original tax/freight)
  const adjustedTotal =
    total != null
      ? Math.round(Number(total) * multiplier * 100) / 100
      : null;

  return {
    lineItems: adjustedItems,
    subtotal: adjustedSubtotal,
    total: adjustedTotal,
    discountApplied: true,
    discountPercent: rule.discountPercent,
  };
}
