import type { OndaReport } from "./onda";
export function demoOndaReport(): OndaReport {
  return {
    version: 1,
    start: "2026-11-01",
    end: "2026-11-02",
    generatedAt: "2026-12-01T02:00:00.000Z",
    rows: 4,
    transactionCount: 3,
    gross: 1346000,
    fees: 46000,
    cashReturned: 25000,
    net: 1275000,
    transactions: [
      {
        reference: "BK-SAMPLE1",
        kind: "BK",
        date: "2026-11-01",
        status: "Paid",
        gross: 620000,
        fee: 20000,
        net: 600000,
        method: "QRPH",
      },
      {
        reference: "ER-SAMPLE2",
        kind: "ER",
        date: "2026-11-01",
        status: "Paid",
        gross: 156000,
        fee: 6000,
        net: 150000,
        method: "Cash",
      },
      {
        reference: "BK-SAMPLE3",
        kind: "BK",
        date: "2026-11-02",
        status: "Paid",
        gross: 570000,
        fee: 20000,
        net: 550000,
        method: "QRPH",
      },
    ],
    refunds: [
      {
        identity: "BK-SAMPLE3/2026-11-02/25000/1",
        reference: "BK-SAMPLE3",
        kind: "BK",
        date: "2026-11-02",
        amount: 25000,
        occurrence: 1,
      },
    ],
    excluded: [],
  };
}
