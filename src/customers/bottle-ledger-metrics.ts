/** Aggregate customer bottle ledger sums by bottle type (internal accounting, not physical counts). */

export type BottleLedgerSplit = {
  netInternal: number;
  obligations: number;
  credits: number;
};

export function ledgerTotalsByBottleType(
  grouped: { bottleTypeId: string; customerId: string; _sum: { delta: number | null } }[],
): Map<string, BottleLedgerSplit> {
  const byType = new Map<string, BottleLedgerSplit>();
  for (const g of grouped) {
    const d = g._sum.delta ?? 0;
    const cur = byType.get(g.bottleTypeId) ?? { netInternal: 0, obligations: 0, credits: 0 };
    cur.netInternal += d;
    if (d > 0) cur.obligations += d;
    else if (d < 0) cur.credits += -d;
    byType.set(g.bottleTypeId, cur);
  }
  return byType;
}
