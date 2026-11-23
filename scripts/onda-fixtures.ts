import { PDFDocument, PageSizes, StandardFonts } from "pdf-lib";
import type { OndaReport, OndaTransaction, OndaRefund } from "../src/lib/onda";
export const tx = (
  reference: string,
  date: string,
  net: number,
  extra: Partial<OndaTransaction> = {},
): OndaTransaction => ({
  reference,
  kind: reference.startsWith("BK") ? "BK" : "ER",
  date,
  status: "Paid",
  gross: net + 2000,
  fee: 2000,
  net,
  method: "QRPH",
  ...extra,
});
export function report(
  transactions: OndaTransaction[],
  refunds: OndaRefund[] = [],
  extra: Partial<OndaReport> = {},
): OndaReport {
  const paid = transactions.filter((t) => t.status === "Paid"),
    gross = paid.reduce((n, t) => n + t.gross, 0),
    fees = paid.reduce((n, t) => n + t.fee, 0),
    cashReturned = refunds.reduce((n, r) => n + r.amount, 0);
  return {
    version: 1,
    start: "2020-11-01",
    end: "2020-11-05",
    generatedAt: "2020-11-06T04:00:00.000Z",
    rows: transactions.length + refunds.length,
    transactionCount: transactions.length,
    gross,
    fees,
    cashReturned,
    net: gross - fees - cashReturned,
    transactions,
    refunds,
    excluded: transactions
      .filter((t) => t.status !== "Paid" || t.net === 0)
      .map((t) => ({
        reference: t.reference,
        reason: t.status === "Paid" ? "Zero payment / complimentary" : t.status,
      })),
    ...extra,
  };
}
export const refund = (
  reference: string,
  date: string,
  amount: number,
  occurrence = 1,
): OndaRefund => ({
  identity: `${reference}/${date}/${amount}/${occurrence}`,
  reference,
  kind: reference.startsWith("BK") ? "BK" : "ER",
  date,
  amount,
  occurrence,
});
const dates = (day: string) => {
  const d = new Date(day + "T00:00:00Z");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
export async function fixturePdf(
  r: OndaReport,
  options: {
    venue?: string;
    summaryNet?: number;
    duplicatePage?: boolean;
    extraPayout?: boolean;
  } = {},
) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica),
    money = (n: number) =>
      "PHP " +
      (n / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  const generated = new Date(r.generatedAt),
    manila = new Date(generated.valueOf() + 8 * 3600000),
    hour = manila.getUTCHours(),
    stamp = `${dates(manila.toISOString().slice(0, 10))} ${hour % 12 || 12}:${String(manila.getUTCMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  const rows: (
    | OndaTransaction
    | OndaRefund
    | { reference: string; kind: "PY"; date: string }
  )[] = [
    ...r.transactions,
    ...r.refunds,
    ...(options.extraPayout
      ? [{ reference: "PY-SAMPLE99", kind: "PY" as const, date: r.start }]
      : []),
  ];
  for (let offset = 0; offset < rows.length || offset === 0; offset += 5) {
    const p = doc.addPage(PageSizes.A4.slice().reverse() as [number, number]);
    const draw = (text: string, x: number, y: number, size = 7) =>
      p.drawText(text, { x, y, size, font });
    draw("Transaction Export", 34, 560, 16);
    draw(
      "Page " + (options.duplicatePage ? 1 : Math.floor(offset / 5) + 1),
      770,
      560,
      9,
    );
    draw(`Date range: ${r.start} to ${r.end}`, 34, 540, 9);
    draw("Generated: " + stamp, 34, 525, 9);
    draw("Rows: " + rows.length, 34, 510, 9);
    draw(
      "Transactions    Total Gross    Cash Returned    Total Onda Fee    Total Net",
      34,
      480,
      9,
    );
    draw(
      `${r.transactionCount + (options.extraPayout ? 1 : 0)}  ${money(r.gross)}  ${money(r.cashReturned)}  ${money(r.fees)}  ${money(options.summaryNet ?? r.net)}`,
      34,
      460,
      9,
    );
    for (const [text, x] of [
      ["REFERENCE", 39],
      ["CLIENT", 112],
      ["CUSTOMER", 205],
      ["METHOD", 287],
      ["CHANNEL", 340],
      ["PAID", 462.87],
      ["ONDA FEE", 529.07],
      ["NET", 635.6],
      ["STATUS", 666.14],
      ["DATE", 714.33],
    ] as const)
      draw(text, x, 407.34, 7);
    rows.slice(offset, offset + 5).forEach((row, i) => {
      const y = 385 - i * 62,
        isRefund = "identity" in row,
        isPayout = row.kind === "PY";
      draw(isRefund ? "Cash return: ER..." : row.reference, 39, y);
      draw(options.venue || "The Gardens Pickleball", 112, y);
      draw("Courts", 112, y - 11);
      draw("Sample guest", 205, y);
      draw(
        isRefund ? "Cash return" : isPayout ? "Original Paym..." : row.method,
        287,
        y,
      );
      draw(isPayout || isRefund ? "-" : "Customer online", 340, y);
      const values = isRefund
        ? [row.amount, 0, -row.amount]
        : isPayout
          ? [null, 0, 90000]
          : [row.gross, row.fee, row.net];
      values.forEach((n, j) => {
        const label = n === null ? "-" : money(n);
        draw(
          label,
          [479.37, 564.34, 649.45][j] - font.widthOfTextAtSize(label, 7),
          y,
        );
      });
      draw(isRefund ? "Recorded" : isPayout ? "Paid" : row.status, 666.14, y);
      draw(isRefund ? row.date : `${dates(row.date)} 3:00 PM`, 714.33, y);
      if (isRefund)
        draw(
          `CASH RETURN: ${money(row.amount)} | SOURCE: ${row.reference} | RECORDED BY: Sample admin`,
          39,
          y - 27,
        );
    });
  }
  return doc.save();
}
