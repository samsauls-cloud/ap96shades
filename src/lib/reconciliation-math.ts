/**
 * Reconciliation Math Verification Engine
 * Runs after every reconciliation to confirm all calculations are correct.
 */

export interface MathCheck {
  name: string;
  expected: number;
  actual: number;
  pass: boolean;
}

export interface ReconciliationTotals {
  receivedValue: number;
  orderedValue: number;
  notReceivedValue: number;
  billedAmount: number;
  creditDueOverbilled: number;
  qtyMismatchAmount: number;
  notOnInvoiceAmount: number;
  totalCreditDue: number;
  finalBillAmount: number;
  variance: number;
  discrepancyLineCount: number;
}

/**
 * Compute all reconciliation totals from session lines + matched invoice.
 */
export function computeReconciliationTotals(
  lines: any[],
  invoiceTotal: number
): ReconciliationTotals {
  let receivedValue = 0;
  let orderedValue = 0;
  let notReceivedValue = 0;
  let creditDueOverbilled = 0;
  let qtyMismatchAmount = 0;
  let notOnInvoiceAmount = 0;
  let discrepancyLineCount = 0;

  for (const l of lines) {
    const unitCost = Number(l.unit_cost || 0);
    const orderQty = Number(l.order_qty || 0);
    const receivedQty = Number(l.received_qty ?? 0);
    const notReceivedQty = Number(l.not_received_qty || 0);

    orderedValue += orderQty * unitCost;
    receivedValue += receivedQty * unitCost;
    notReceivedValue += notReceivedQty * unitCost;

    if (l.billing_discrepancy) {
      discrepancyLineCount++;
      const amt = Number(l.discrepancy_amount || 0);
      switch (l.discrepancy_type) {
        case 'OVERBILLED':
          creditDueOverbilled += amt;
          break;
        case 'QTY_MISMATCH':
          qtyMismatchAmount += amt;
          break;
        case 'NOT_ON_INVOICE':
          notOnInvoiceAmount += amt;
          break;
      }
    }
  }

  const totalCreditDue = creditDueOverbilled;
  const finalBillAmount = invoiceTotal - totalCreditDue;
  const variance = invoiceTotal - orderedValue;

  return {
    receivedValue: round2(receivedValue),
    orderedValue: round2(orderedValue),
    notReceivedValue: round2(notReceivedValue),
    billedAmount: round2(invoiceTotal),
    creditDueOverbilled: round2(creditDueOverbilled),
    qtyMismatchAmount: round2(qtyMismatchAmount),
    notOnInvoiceAmount: round2(notOnInvoiceAmount),
    totalCreditDue: round2(totalCreditDue),
    finalBillAmount: round2(finalBillAmount),
    variance: round2(variance),
    discrepancyLineCount,
  };
}

/**
 * Run all math verification checks after reconciliation.
 */
export function verifyReconciliationMath(
  lines: any[],
  sessionTotalOrderedCost: number,
  sessionTotalOrderedQty: number,
  invoiceTotal: number,
  totals: ReconciliationTotals
): MathCheck[] {
  const checks: MathCheck[] = [];

  // Check 1: line items sum to session ordered total
  const lineSum = lines.reduce(
    (s: number, l: any) => s + Number(l.order_qty || 0) * Number(l.unit_cost || 0),
    0
  );
  checks.push({
    name: 'Line items sum to ordered total',
    expected: round2(sessionTotalOrderedCost),
    actual: round2(lineSum),
    pass: Math.abs(lineSum - sessionTotalOrderedCost) < 0.02,
  });

  // Check 2: received + not_received = ordered (qty)
  const totalReceived = lines.reduce(
    (s: number, l: any) => s + Number(l.received_qty ?? 0),
    0
  );
  const totalNotReceived = lines.reduce(
    (s: number, l: any) => s + Number(l.not_received_qty || 0),
    0
  );
  checks.push({
    name: 'Received + Not Received = Ordered (qty)',
    expected: sessionTotalOrderedQty,
    actual: totalReceived + totalNotReceived,
    pass: totalReceived + totalNotReceived === sessionTotalOrderedQty,
  });

  // Check 3: credit due = sum of overbilled lines
  const overbilledSum = lines
    .filter((l: any) => l.discrepancy_type === 'OVERBILLED')
    .reduce((s: number, l: any) => s + Number(l.discrepancy_amount || 0), 0);
  checks.push({
    name: 'Credit due = sum of overbilled lines',
    expected: round2(overbilledSum),
    actual: round2(totals.creditDueOverbilled),
    pass: Math.abs(overbilledSum - totals.creditDueOverbilled) < 0.02,
  });

  // Check 4: final bill = invoice total - credits
  const expectedFinalBill = invoiceTotal - totals.totalCreditDue;
  checks.push({
    name: 'Final bill = invoice total - credits',
    expected: round2(expectedFinalBill),
    actual: round2(totals.finalBillAmount),
    pass: Math.abs(expectedFinalBill - totals.finalBillAmount) < 0.02,
  });

  // Check 5: variance flag
  checks.push({
    name: 'Variance within tolerance',
    expected: 0,
    actual: round2(totals.variance),
    pass: Math.abs(totals.variance) <= 1.0,
  });

  return checks;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
