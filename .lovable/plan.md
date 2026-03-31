

## Plan: Audit Page Correctness Review + Error/Warning Detail Visibility

### Problem
1. The three health score badges (ERROR, ERROR, WARNING) at the top don't tell you **what** the error/warning is — you have to expand each audit section to find out.
2. Several correctness issues exist in the audit logic that could show misleading numbers.

### Correctness Issues Found

1. **Hardcoded $597K gap analysis** (lines 531-533): The "Missing Invoice Finder" card compares against a hardcoded `$597,131.71` Excel figure. This is stale and misleading as more invoices are added — should be removed or made dynamic.

2. **Hardcoded vendor IDs** (line 127): `knownVendorIds = ["3", "5", "14", "15"]` is brittle — should pull from `vendor_alias_map` table or derive dynamically from sessions.

3. **Hardcoded "All 133 invoices"** text (line 519): Says "All 133 invoices" which is a stale snapshot — should use `invoiceStats.invoiceCount`.

4. **Payment schedule comparison uses `invoiceTotal` (confirmed-terms only) but payment sum includes ALL payments** (lines 551-554): This creates a false gap because some payments may exist for invoices that later changed `terms_status`. Both sides should use the same filter.

5. **LS Match Coverage counts `partial` as "matched"** (line 397): A partial match (qty variance) is counted toward coverage %, which inflates the number. This may be intentional but should be clearly labeled.

### UI Changes: Error/Warning Summary in Health Score Card

Add a **tooltip or inline summary** next to each status badge in the health score card so you can see at a glance what each error/warning is about without scrolling.

```text
┌─────────────────────────────────────────────────────────────────┐
│ 🛡 Reconciliation Health: 0/3 checks passing                   │
│   3 check(s) need attention                                     │
│                                                                 │
│  Audit 1 — Engine Accuracy     🚨 ERROR                        │
│    → 2 cross-vendor mismatches found                            │
│                                                                 │
│  Audit 2 — Missing LS POs      🚨 ERROR                        │
│    → 40 invoices with no Lightspeed receipt ($76K value)        │
│                                                                 │
│  Audit 3 — Payment Schedules   ⚠ WARNING                       │
│    → 5 invoices with payment sum mismatch                       │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Steps

1. **Fix correctness issues in `Audit.tsx`**:
   - Remove hardcoded `$597,131.71` gap card or replace with a dynamic "invoices without payments" summary
   - Fix hardcoded "133" to use `invoiceStats.invoiceCount`
   - Align payment sum comparison to use same confirmed-terms filter

2. **Fix hardcoded vendor IDs in `ReconciliationAuditPanel.tsx`**:
   - Derive known vendor IDs from the receiving sessions data instead of hardcoding

3. **Add error/warning detail summaries to health score card in `ReconciliationAuditPanel.tsx`**:
   - Below the health score headline, show a compact list of each audit with its status badge and a one-line description of what's wrong
   - Each line is clickable to scroll/expand that audit section
   - Format: `Audit N — [Name] [BADGE] → [summary of finding]`

4. **Pass audit summaries up** from the `useMemo` hooks — add summary text strings to each audit result object (e.g., `audit1.summary = "2 cross-vendor mismatches"`)

### Files Changed
- `src/components/invoices/ReconciliationAuditPanel.tsx` — add summary lines to health card, fix hardcoded vendor IDs
- `src/pages/Audit.tsx` — fix hardcoded values and stale references

