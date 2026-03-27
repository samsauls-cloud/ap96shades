/**
 * CSV PO Parser for Lightspeed PO exports.
 * Converts CSV rows into VendorInvoiceInsert records (doc_type = "PO")
 * so they flow through the same pipeline as PDF invoices.
 */

import type { VendorInvoiceInsert } from "@/lib/supabase-queries";
import { normalizeVendor } from "@/lib/invoice-dedup";
import { applyVendorDiscount } from "@/lib/vendor-pricing-rules";
import {
  parseCSV, detectFormat, parseLines, vendorFromLightspeed,
  type ExportFormat, type ParsedLine,
} from "@/lib/receiving-engine";

export interface CSVParseResult {
  invoices: VendorInvoiceInsert[];
  format: ExportFormat;
  totalLines: number;
  vendorSummary: Record<string, number>;
  discountApplied: boolean;
}

/**
 * Parse a Lightspeed PO CSV file and return VendorInvoiceInsert records
 * grouped by vendor. Applies vendor-specific discounts (e.g. Marchon 10%).
 */
export function parseCSVToPOs(csvText: string, filename: string): CSVParseResult {
  const { headers, rows } = parseCSV(csvText);

  if (headers.length === 0 || rows.length === 0) {
    throw new Error("CSV file is empty or has no data rows");
  }

  const format = detectFormat(headers);
  if (format === "UNKNOWN") {
    throw new Error(
      "Unrecognized CSV format. Expected a Lightspeed PO export with columns like 'UPC', 'Order Qty.', 'Unit Cost'."
    );
  }

  const parsed = parseLines(headers, rows, format);

  // Group lines by vendor
  const linesByVendor = new Map<string, ParsedLine[]>();
  for (const line of parsed) {
    const vendor = normalizeVendor(
      vendorFromLightspeed(line.vendor_id, line.item_description)
    );
    if (!linesByVendor.has(vendor)) linesByVendor.set(vendor, []);
    linesByVendor.get(vendor)!.push(line);
  }

  const vendorSummary: Record<string, number> = {};
  const invoices: VendorInvoiceInsert[] = [];
  let anyDiscountApplied = false;

  for (const [vendor, lines] of linesByVendor) {
    vendorSummary[vendor] = lines.length;

    // Convert parsed lines to line_items format matching invoice schema
    const lineItems = lines.map((l) => ({
      upc: l.upc || undefined,
      item_number: l.manufact_sku || l.custom_sku || undefined,
      sku: l.system_id || undefined,
      description: l.item_description || undefined,
      brand: extractBrandFromDescription(l.item_description),
      model: extractModelFromSKU(l.manufact_sku),
      qty_ordered: l.order_qty,
      qty_shipped: l.received_qty ?? undefined,
      qty: l.order_qty,
      unit_price: l.unit_cost,
      line_total: l.order_qty * l.unit_cost,
    }));

    // Apply vendor discounts (e.g. Marchon 10%)
    const subtotalRaw = lineItems.reduce((s, li) => s + (li.line_total || 0), 0);
    const { lineItems: adjustedItems, subtotal, total, discountApplied, discountPercent } =
      applyVendorDiscount(vendor, lineItems, subtotalRaw, subtotalRaw);

    if (discountApplied) anyDiscountApplied = true;

    const discountNote = discountApplied
      ? `${discountPercent}% vendor discount applied. `
      : "";

    // Generate a PO number from the filename
    const poNumber = filename
      .replace(/\.csv$/i, "")
      .replace(/\s*\(\d+\)$/, "") // strip browser rename suffix
      .trim();

    const today = new Date().toISOString().split("T")[0];

    invoices.push({
      vendor,
      doc_type: "PO",
      invoice_number: `PO-${poNumber}-${vendor.replace(/\s/g, "")}`,
      invoice_date: today,
      po_number: poNumber,
      subtotal: subtotal as number ?? subtotalRaw,
      tax: 0,
      freight: 0,
      total: total as number ?? subtotalRaw,
      currency: "USD",
      vendor_brands: [...new Set(adjustedItems.map((li: any) => li.brand).filter(Boolean))],
      notes: `${discountNote}Imported from Lightspeed CSV: ${filename}. Format: ${format}. ${lines.length} line items.`,
      filename,
      line_items: adjustedItems,
    });
  }

  return {
    invoices,
    format,
    totalLines: parsed.length,
    vendorSummary,
    discountApplied: anyDiscountApplied,
  };
}

/**
 * Extract brand name from Lightspeed item description.
 * Lightspeed descriptions typically start with the brand name.
 */
function extractBrandFromDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  const upper = desc.toUpperCase().trim();

  const knownBrands = [
    "RAY-BAN", "RAYBAN", "OAKLEY", "PRADA", "VERSACE", "COACH",
    "MICHAEL KORS", "BURBERRY", "PERSOL", "VOGUE", "RALPH", "ARNETTE",
    "OLIVER PEOPLES", "COSTA DEL MAR", "COSTA",
    "GUCCI", "SAINT LAURENT", "BOTTEGA VENETA", "BALENCIAGA",
    "ALEXANDER MCQUEEN", "CARTIER",
    "TOM FORD", "GUESS", "SWAROVSKI", "MONTBLANC",
    "CARRERA", "BOSS", "HUGO BOSS", "JIMMY CHOO", "FOSSIL", "KATE SPADE",
    "MAUI JIM",
    "NIKE", "COLUMBIA", "DRAGON", "FLEXON", "CALVIN KLEIN", "DONNA KARAN",
    "LACOSTE", "SALVATORE FERRAGAMO", "MCM", "NAUTICA", "NINE WEST", "SKAGA",
    "CHANEL",
  ].sort((a, b) => b.length - a.length); // longest first

  for (const brand of knownBrands) {
    if (upper.includes(brand)) return brand;
  }

  // Fallback: first word(s) before a model number pattern
  const match = desc.match(/^([A-Za-z\s-]+?)(?:\s+\d|$)/);
  return match ? match[1].trim() : undefined;
}

/**
 * Extract model number from manufacturer SKU.
 */
function extractModelFromSKU(sku: string | undefined): string | undefined {
  if (!sku) return undefined;
  return sku.trim() || undefined;
}

/**
 * Read a File as text.
 */
export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read CSV file"));
    reader.readAsText(file);
  });
}
