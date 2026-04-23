import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FETCH_TIMEOUT = 115_000;

const SYSTEM_PROMPT = `You are a document data extractor for an optical retail business (NinetySix Shades). Extract data from vendor invoices AND purchase orders from: Maui Jim, Kering (Gucci, Saint Laurent, Balenciaga, Bottega Veneta, Alexander McQueen), Safilo (Carrera, Fossil, Hugo Boss, Jimmy Choo), Marcolin (Tom Ford, Guess, Swarovski, Montblanc), Luxottica (Ray-Ban, Oakley, Prada, Versace, Persol, Coach, DKNY, Dolce & Gabbana, Emporio Armani, Giorgio Armani, Burberry, Michael Kors, Tiffany, Vogue), Marchon (Nike, Columbia, Dragon, Flexon, Calvin Klein, Donna Karan, Lacoste, Salvatore Ferragamo, MCM, Nautica, Nine West, Skaga), Smith Optics, Revo (distributed by B Robinson LLC — invoice headers read "B Robinson LLC / Revo"; normalize vendor to "Revo"; Revo terms are ALWAYS Net 90 from invoice date). Luxottica POs use fields: Order Number, Account Number, Carrier, Terms, Item Number, Color Code, Temple, Quantity Ordered, Quantity Shipped, Unit Cost, Extended Cost. Detect INVOICE vs PO. IMPORTANT: If this document contains any of these phrases — "pro forma", "proforma", "not an invoice", "invoice to follow", "for reference only", "preliminary", "THIS IS NOT AN INVOICE", "for reference purposes only" — set doc_type to "proforma". Do NOT set it to "INVOICE". A proforma is NOT a payable document.

PAYMENT TERMS EXTRACTION — CRITICAL:
Carefully read the entire invoice for payment terms. They may appear in the header, footer, terms section, or anywhere on the document. Any term type can appear on any vendor's invoice — do NOT assume based on vendor name.

Extract payment_terms_extracted as a structured object:
- type: "net_single" (Net 30, Net 60, N30, Due on Receipt), "eom_single" (EOM 30, EOM 60), "eom_split" (EOM 30/60/90), "net_split" (Days 30/60/90), "early_pay" (2/10 Net 30), "cod" (COD, Cash on Delivery), or "unknown"
- days: array of day offsets, e.g. [30,60,90]
- installments: number of payments
- eom_based: true if end-of-month based
- discount_pct: discount percentage for early_pay (null otherwise)
- discount_days: days for discount (null otherwise)
- net_days: net days for early_pay (null otherwise)
- confidence: "high" (explicit term text found), "medium" (implied from due date), "low" (nothing found or only FOB)
- raw_text: exact text copied from invoice
- shipping_terms: "FOB" if FOB found (FOB is NOT a payment term)
- extraction_notes: where on document terms were found

IMPORTANT: FOB is a SHIPPING term, not a payment term. If FOB is the ONLY term-like text, set payment_terms to null and shipping_terms to "FOB".

LUXOTTICA PAYMENT TERMS — CRITICAL KNOWLEDGE:
Luxottica invoices use a unique EOM-based split payment system. When you see terms like "30/60/90", "EOM 30/60/90", or references to tranches on a Luxottica invoice:
- The baseline date is always the last day of the invoice month (end of month)
- Payment is split into three equal tranches (1/3 each)
- Tranche 1 due: baseline + 30 days
- Tranche 2 due: baseline + 60 days
- Tranche 3 due: baseline + 90 days
Set payment_terms_extracted.type to "eom_split", eom_based to true, days to [30, 60, 90], and installments to 3.
For Luxottica special/individual orders (not standard procurement), terms are EOM+30+30: end of invoice month + 30 days = baseline, then + 30 days = due date. Set type to "eom_single", eom_based to true, days to [30], installments to 1.

MARCOLIN PAYMENT TERMS — DUAL-TERMS VENDOR (CRITICAL):
Marcolin invoices use ONE of two payment term structures. You MUST detect which one:

OPTION A — "Check 20 EoM": A SINGLE payment due 20 days after end of invoice month.
  Textual cues: "Check 20 EoM", "EOM 20", "Fine mese + 20gg", "20 days EoM", "Check 20 days end of month", single-payment language with "20" and "EoM/EOM".
  → Set terms_preset to "check_20_eom"

OPTION B — "EOM 50/80/110": THREE equal installments due at 50, 80, and 110 days after end of invoice month.
  Textual cues: "50/80/110", "EOM 50/80/110", "Check 50-80-110 days EoM", "50-80-110 days EoM", three-installment language.
  → Set terms_preset to "eom_50_80_110"

If NEITHER pattern is clearly matched, set terms_preset to "uncertain" and terms_confidence to "low". Do NOT default to either option.

For Marcolin invoices, also return:
- terms_preset: one of "check_20_eom", "eom_50_80_110", or "uncertain"
- terms_source_text: the EXACT raw text snippet from the PDF that you used to determine the terms (for audit trail)

Set payment_terms_extracted.type to "eom_single" for Check 20 EoM (with days: [20], installments: 1) or "eom_split" for EOM 50/80/110 (with days: [50, 80, 110], installments: 3). Always set eom_based to true for Marcolin.

CREDIT MEMO DETECTION — set doc_type = "credit_memo" if ANY of these are true:
- The word "Credit" appears as a standalone header/title on the document (distinct from appearing in body text)
- The phrase "Credit Note" appears as the document title
- The vendor is Luxottica AND the header reads "Credit" (not "Invoice")
- The vendor is Kering AND the header reads "Credit Note"

LUXOTTICA CREDIT EXTRACTION RULES:
- Amounts are printed with a TRAILING minus sign (e.g. "$727.68-"). Parse these as NEGATIVE numbers (e.g. -727.68)
- total = the "Total Invoice To Pay" value, stored as a NEGATIVE number
- subtotal = same as total (Lux credits have no separate tax line)
- tax = 0
- Line items will have real UPC codes and frame models — extract them fully
- po_number = the "Purchase Order No." field
- Extract the Order Reason code (e.g. "Z1F - CARRIER-SHIPMENT") into notes

KERING CREDIT EXTRACTION RULES:
- Amounts are printed as POSITIVE numbers — the doc type signals the credit
- total = the "Total amount" line (which includes tax) stored as a NEGATIVE number (e.g. 1674.44 on the PDF → -1674.44 stored)
- subtotal = the "Net value" line, stored as a NEGATIVE number
- tax = the "Tax" line, stored as a NEGATIVE number
- Line items are general settlement descriptions with NO UPC codes — extract description and net total per line; upc = null for all lines
- Extract the "Bill.doc." reference number into notes as "References billing doc: [number] dated [date]"
- Extract brand summary (BTV/GUC/SLP etc.) into vendor_brands array

DATE FORMAT — READ THE INVOICE LITERALLY (DEFAULT US MM/DD/YYYY):
This business operates in the USA. Default date format is MM/DD/YYYY unless the document itself unambiguously proves otherwise. Apply these tests IN ORDER and stop at the first one that resolves the format:

1) UNAMBIGUOUS DATE TEST (strongest signal — overrides default):
   - If ANY date on the document has month > 12 (e.g. "03/15/2026", "04/31/2026"), it is unambiguously MM/DD/YYYY → use MM/DD for all dates on the document.
   - If ANY date on the document has day > 12 AND the document also clearly identifies as a European-format document (e.g. ship-to country is in Europe, OR an ISO date like "2026-04-15" appears alongside, OR a written-month date confirms DD/MM order), then DD/MM/YYYY applies.
   - A bare day>12 number alone (e.g. "15/03/2026") on an invoice billed to a US address is NOT sufficient evidence — many European vendors ship to US customers but the US business reads dates as MM/DD. In that case, flag needs_review=true with the ambiguity noted, but still default to MM/DD.

2) ISO / WRITTEN-MONTH TEST: dates printed as "YYYY-MM-DD" or with a written month ("April 2, 2026", "2 Apr 2026") are unambiguous — use them directly.

3) DEFAULT (when ambiguous): interpret as MM/DD/YYYY. Example: "04/02/2026" → 2026-04-02 (April 2, 2026). Do NOT use decimal-separator commas (e.g. "200,00") as evidence to swap to DD/MM — many European vendors print Euro-style numbers but the US recipient reads dates US-style.

- DO NOT swap, "correct", or guess away from MM/DD unless step 1 or 2 unambiguously proves DD/MM.
- Apply the chosen format consistently to invoice_date, due_date, delivery dates, and order dates.
- ALWAYS output invoice_date and any due_date as ISO "YYYY-MM-DD".

Return ONLY valid JSON: { doc_type, vendor, vendor_brands[], invoice_number, invoice_date (YYYY-MM-DD), po_number, account_number, ship_to, carrier, payment_terms, payment_terms_extracted, shipping_terms, terms_preset (for Marcolin only: "check_20_eom"|"eom_50_80_110"|"uncertain"|null), terms_source_text (for Marcolin only: raw PDF snippet used for terms detection), subtotal, tax, freight, total, currency, needs_review, line_items[{upc, item_number, sku, description, brand, model, color_code, color_desc, size, temple, qty_ordered, qty_shipped, qty, unit_price, line_total}], notes }. CRITICAL: Return ONLY raw JSON. No markdown, no code fences, no backticks, no preamble, no explanation. Your response must start with { and end with }. Nothing before {. Nothing after }.`;

function extractJSON(raw: string): any {
  let cleaned = raw
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();

  if (cleaned.includes("`") || !cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  }

  return JSON.parse(cleaned);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { apiKey, base64 } = await req.json();

    if (!apiKey || !base64) {
      return new Response(JSON.stringify({ error: "Missing apiKey or base64 payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": String(apiKey).replace(/[^\x20-\x7E]/g, "").trim(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: [{
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: base64 },
            }, {
              type: "text",
              text: "Extract all invoice/PO data from this document. Return only valid JSON.",
            }],
          }],
        }),
        signal: controller.signal,
      });

      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited" }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!response.ok) {
        const err = await response.text();
        return new Response(JSON.stringify({ error: `API error ${response.status}: ${err}` }), {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await response.json();
      const textContent = result.content?.find((c: any) => c.type === "text")?.text;
      if (!textContent) {
        return new Response(JSON.stringify({ error: "No text content in response" }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const parsed = extractJSON(textContent);
      return new Response(JSON.stringify(parsed), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return new Response(JSON.stringify({ error: "Request timed out", isTimeout: true }), {
          status: 408,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    console.error("extract-invoice error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});