import { toDate } from "./finance";
import type { OndaKind, OndaRefund, OndaReport, OndaTransaction } from "./onda";
import { ONDA_MAX_BYTES } from "./onda";
export interface PdfWord {
  text: string;
  x: number;
  y: number;
  width: number;
}
export interface PdfTextPage {
  width: number;
  height: number;
  words: PdfWord[];
}
const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function amount(text: string) {
  const v = text
    .replace(/^PHP\s*/, "")
    .replaceAll(",", "")
    .trim();
  if (!/^-?\d+\.\d{2}$/.test(v))
    throw Error("An amount could not be read. Export a fresh Onda PDF.");
  const [a, b] = v.replace("-", "").split(".");
  const n = (Number(a) * 100 + Number(b)) * (v.startsWith("-") ? -1 : 1);
  if (!Number.isSafeInteger(n) || Math.abs(n) > 999999999999)
    throw Error("A report amount is too large.");
  return n;
}
function dateTime(value: string) {
  const m = value.match(
    /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/,
  );
  if (!m) throw Error("Report date/time is unsupported.");
  const index = months.indexOf(m[1]);
  if (index < 0 || +m[4] < 1 || +m[4] > 12 || +m[5] > 59)
    throw Error("Invalid report date/time.");
  const date = `${m[3]}-${String(index + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  toDate(date);
  const h = (+m[4] % 12) + (m[6] === "PM" ? 12 : 0);
  return {
    date,
    iso: new Date(
      `${date}T${String(h).padStart(2, "0")}:${m[5]}:00+08:00`,
    ).toISOString(),
  };
}
function lines(page: PdfTextPage) {
  const sorted = page.words
    .filter((w) => w.text.trim())
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: { y: number; words: PdfWord[] }[] = [];
  for (const word of sorted) {
    const last = groups[groups.length - 1],
      group = last && Math.abs(last.y - word.y) < 2 ? last : null;
    if (group) group.words.push(word);
    else groups.push({ y: word.y, words: [word] });
  }
  return groups.map((g) => ({
    ...g,
    words: g.words.sort((a, b) => a.x - b.x),
    text: g.words
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}
export function parseOndaPages(
  pages: PdfTextPage[],
  now = new Date(),
): OndaReport {
  if (!pages.length || pages.length > 100)
    throw Error("Upload an Onda PDF with 1 to 100 pages.");
  const all = pages.map(lines),
    first = all[0].map((l) => l.text).join("\n");
  if (!first.includes("Transaction Export"))
    throw Error("This is not a supported Onda Transaction Export.");
  const range = first.match(
      /Date range: (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/,
    ),
    generated = first.match(
      /Generated: ([A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M)/,
    ),
    rowHeader = first.match(/Rows: (\d+)/);
  if (!range || !generated || !rowHeader)
    throw Error("The report dates, row count or generation time are missing.");
  const start = range[1],
    end = range[2];
  const span = (toDate(end).valueOf() - toDate(start).valueOf()) / 86400000;
  if (span < 0 || span > 365)
    throw Error("Choose a report date range of up to 366 days.");
  const stamp = dateTime(generated[1]);
  if (
    stamp.date < end ||
    new Date(stamp.iso).valueOf() > now.valueOf() + 300000
  )
    throw Error("Report generation time or reporting range is invalid.");
  const summary = all[0].find((l) => /^\d+\s+PHP /.test(l.text));
  if (!summary) throw Error("The Onda summary totals are missing.");
  const summaryAmounts = [
    ...summary.text.matchAll(/PHP\s+(-?[\d,]+\.\d{2})/g),
  ].map((m) => amount(m[1]));
  if (summaryAmounts.length !== 4)
    throw Error("The Onda summary format is unsupported.");
  const transactionCount = Number(summary.text.match(/^\d+/)![0]),
    [gross, cashReturned, fees, net] = summaryAmounts;
  const transactions: OndaTransaction[] = [],
    refunds: OndaRefund[] = [],
    excluded: OndaReport["excluded"] = [],
    seen = new Set<string>();
  let count = 0;
  for (let p = 0; p < all.length; p++) {
    const page = all[p],
      text = page.map((l) => l.text).join("\n");
    if (
      !text.includes(`Date range: ${start} to ${end}`) ||
      !text.includes(`Rows: ${rowHeader[1]}`) ||
      !text.includes(`Generated: ${generated[1]}`)
    )
      throw Error("Pages from different or incomplete reports were detected.");
    const pageNumber = text.match(/\bPage (\d+)\b/);
    if (!pageNumber || Number(pageNumber[1]) !== p + 1)
      throw Error("Report pages are missing, duplicated or out of order.");
    const head = page.find(
      (l) =>
        l.words.some((w) => w.text === "REFERENCE") &&
        l.words.some((w) => w.text === "CUSTOMER"),
    );
    if (!head) throw Error("The transaction table header is missing.");
    const x = (name: string) =>
      head.words.find(
        (w) => w.text === name || (name === "ONDA" && w.text === "ONDA FEE"),
      )?.x;
    const client = x("CLIENT"),
      customer = x("CUSTOMER"),
      method = x("METHOD"),
      channel = x("CHANNEL"),
      paid = x("PAID"),
      fee = x("ONDA"),
      netX = x("NET"),
      status = x("STATUS"),
      dateX = x("DATE");
    if (
      [client, customer, method, channel, paid, fee, netX, status, dateX].some(
        (v) => v === undefined,
      )
    )
      throw Error("The transaction columns are unsupported.");
    const cell = (row: typeof head, left: number, right: number) =>
      row.words
        .filter((w) => w.x >= left - 2 && w.x < right - 2)
        .map((w) => w.text)
        .join(" ")
        .trim();
    for (let i = 0; i < page.length; i++) {
      const row = page[i];
      if (row.y <= head.y) continue;
      const refCell = cell(row, 0, client!);
      const reference = refCell.match(/^([A-Z]{2}-[A-Z0-9]+)$/)?.[1],
        isReturn = /^Cash return:/.test(refCell);
      if (!reference && !isReturn) {
        if (/^([A-Z]{2}-|Cash return:)/.test(refCell))
          throw Error("A transaction reference is truncated or unsupported.");
        continue;
      }
      count++;
      let next = i + 1;
      while (
        next < page.length &&
        !/^([A-Z]{2}-[A-Z0-9]+|Cash return:)/.test(cell(page[next], 0, client!))
      )
        next++;
      const details = page
          .slice(i + 1, next)
          .map((l) => l.text)
          .join(" "),
        venue =
          cell(row, client!, customer!) +
          " " +
          (page[i + 1] ? cell(page[i + 1], client!, customer!) : "");
      if (
        venue.replace(/\s+/g, " ").trim().toLowerCase() !==
        "the gardens pickleball courts"
      )
        throw Error(
          "This report contains a venue other than The Gardens Pickleball Courts.",
        );
      const values = [
        ...cell(row, channel!, status!).matchAll(/PHP\s+(-?[\d,]+\.\d{2})/g),
      ].map((m) => m[1]);
      const state = cell(row, status!, dateX!),
        when = cell(row, dateX!, pages[p].width + 1),
        payment = cell(row, method!, channel!);
      if (isReturn) {
        const source = details.match(
          /CASH RETURN:.*?SOURCE: ((BK|ER)-[A-Z0-9]+)/,
        );
        if (
          !source ||
          state !== "Recorded" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(when)
        )
          throw Error("A cash return has an unreadable source or date.");
        toDate(when);
        if (values.length !== 3)
          throw Error("A cash return amount is incomplete.");
        const n = amount(values[0]);
        if (n <= 0 || amount(values[1]) !== 0 || amount(values[2]) !== -n)
          throw Error("A cash return does not reconcile.");
        const base = `${source[1]}/${when}/${n}`,
          occurrence =
            refunds.filter(
              (r) => `${r.reference}/${r.date}/${r.amount}` === base,
            ).length + 1;
        refunds.push({
          identity: `${base}/${occurrence}`,
          reference: source[1],
          kind: source[2] as OndaKind,
          date: when,
          amount: n,
          occurrence,
        });
        continue;
      }
      if (seen.has(reference!))
        throw Error(
          "A transaction reference occurs more than once in this PDF.",
        );
      seen.add(reference!);
      const prefix = reference!.slice(0, 2);
      if (prefix === "PY") {
        excluded.push({
          reference: reference!,
          reason: "Payout / non-revenue",
        });
        continue;
      }
      if (prefix !== "BK" && prefix !== "ER")
        throw Error("An unknown transaction type requires manual review.");
      if (
        ![
          "Paid",
          "Cancelled",
          "Pending",
          "Refunded",
          "Failed",
          "Unpaid",
        ].includes(state)
      )
        throw Error("An unsupported payment status requires manual review.");
      if (values.length !== 3)
        throw Error("A transaction amount is incomplete.");
      const date = dateTime(when).date,
        g = amount(values[0]),
        f = amount(values[1]),
        n = amount(values[2]);
      if (g < 0 || f < 0 || n < 0 || g - f !== n)
        throw Error("A transaction amount does not reconcile.");
      if (
        state === "Paid" &&
        n > 0 &&
        ![
          "Cash",
          "QRPH",
          "GCash",
          "Maya",
          "Card",
          "Credit Card",
          "Debit Card",
          "Bank transfer",
        ].includes(payment)
      )
        throw Error("An unknown paid payment method requires review.");
      transactions.push({
        reference: reference!,
        kind: prefix,
        date,
        status: state,
        gross: g,
        fee: f,
        net: n,
        method: payment,
      });
      if (state !== "Paid" || n === 0)
        excluded.push({
          reference: reference!,
          reason: state !== "Paid" ? state : "Zero payment / complimentary",
        });
    }
  }
  if (
    count !== Number(rowHeader[1]) ||
    transactions.length +
      excluded.filter((e) => e.reason === "Payout / non-revenue").length !==
      transactionCount
  )
    throw Error(
      "The parsed rows do not match the report row count. Export a complete PDF.",
    );
  if (
    transactions.some((t) => t.date < start || t.date > end) ||
    refunds.some((r) => r.date < start || r.date > end)
  )
    throw Error("Transactions fall outside the report date range.");
  const paid = transactions.filter((t) => t.status === "Paid"),
    sum = (key: "gross" | "fee" | "net") =>
      paid.reduce((n, t) => n + t[key], 0),
    returned = refunds.reduce((n, r) => n + r.amount, 0);
  if (
    sum("gross") !== gross ||
    sum("fee") !== fees ||
    returned !== cashReturned ||
    sum("net") - returned !== net
  )
    throw Error(
      "Transactions do not match the Onda summary totals. Nothing can be imported.",
    );
  return {
    version: 1,
    start,
    end,
    generatedAt: stamp.iso,
    rows: count,
    transactionCount,
    gross,
    fees,
    cashReturned,
    net,
    transactions,
    refunds,
    excluded,
  };
}
export async function parseOndaPdf(bytes: Uint8Array, now = new Date()) {
  if (
    !bytes.length ||
    bytes.length > ONDA_MAX_BYTES ||
    new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-"
  )
    throw Error("Choose one PDF no larger than 4 MB.");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    useWorkerFetch: false,
    disableFontFace: true,
    useWasm: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    if ((await doc.getPermissions()) !== null)
      throw Error(
        "Encrypted PDFs are not supported. Export an unencrypted Onda PDF.",
      );
    if (doc.numPages > 100)
      throw Error("Split the export into PDFs of at most 100 pages.");
    const pages: PdfTextPage[] = [];
    let itemCount = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i),
        content = await page.getTextContent(),
        viewport = page.getViewport({ scale: 1 });
      itemCount += content.items.length;
      if (itemCount > 200000)
        throw Error("This PDF is too complex. Export a shorter report.");
      const words: PdfWord[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        words.push({
          text: item.str,
          x: item.transform[4],
          y: viewport.height - item.transform[5],
          width: item.width,
        });
      }
      pages.push({ width: viewport.width, height: viewport.height, words });
      page.cleanup();
    }
    if (pages.every((p) => !p.words.length))
      throw Error(
        "Scanned PDFs are not supported. Upload the original Onda export.",
      );
    return parseOndaPages(pages, now);
  } catch (e) {
    if (e instanceof Error && e.name === "PasswordException")
      throw Error("Password-protected PDFs are not supported.");
    if (e instanceof Error && e.name === "InvalidPDFException")
      throw Error("The PDF is damaged or incomplete. Export it again.");
    throw e;
  } finally {
    await task.destroy();
  }
}
