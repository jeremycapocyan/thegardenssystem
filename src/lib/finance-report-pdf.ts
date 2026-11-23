import { PDFDocument, PageSizes, rgb, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { displayDate, displayMonth, money } from "./finance";
import type { TimesheetPdfAssets } from "./timesheet-pdf";
import type { FinanceReport } from "./finance-report";
import { ACCOUNTS, type CashAccount } from "./balances";

type Column = { label: string; weight: number; right?: boolean };
type Row = { cells: string[]; total?: boolean };
const navy = rgb(0, 27 / 255, 61 / 255),
  burgundy = rgb(142 / 255, 48 / 255, 48 / 255),
  gold = rgb(181 / 255, 139 / 255, 37 / 255),
  cream = rgb(1, 250 / 255, 220 / 255),
  muted = rgb(0.38, 0.36, 0.31),
  line = rgb(0.88, 0.86, 0.8);
export async function createFinanceReportPdf(
  r: FinanceReport,
  assets: TimesheetPdfAssets,
) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(
    `The Gardens - Finance report ${r.options.start} to ${r.options.end}`,
  );
  doc.setAuthor("The Gardens");
  doc.setCreationDate(new Date(r.generatedAt));
  doc.setModificationDate(new Date(r.generatedAt));
  const font = await doc.embedFont(assets.regular, { subset: true }),
    bold = await doc.embedFont(assets.bold, { subset: true });
  if (!font.getCharacterSet().includes(0x20b1))
    throw Error("The report font must support Philippine pesos.");
  const supported = new Set(font.getCharacterSet());
  let replaced = false;
  const clean = (s: string) =>
    Array.from(
      s
        .replace(/[\u0000-\u0008\u000b-\u001f]/g, " ")
        .replace(/[\u2010-\u2015\u2212]/g, "-"),
    )
      .map((c) => {
        if (c === "\n" || supported.has(c.codePointAt(0)!)) return c;
        replaced = true;
        return "?";
      })
      .join("");
  const crest = await doc.embedJpg(assets.crest),
    wordmark = await doc.embedPng(assets.wordmark);
  const [portraitW, portraitH] = PageSizes.A4,
    width = portraitH,
    height = portraitW,
    margin = 32,
    content = width - margin * 2,
    bottom = 50;
  let page!: PDFPage;
  let y = 0;
  const text = (
    s: string,
    x: number,
    at: number,
    size = 8.5,
    strong = false,
    color = navy,
  ) =>
    page.drawText(clean(s), {
      x,
      y: at,
      size,
      font: strong ? bold : font,
      color,
    });
  const wrap = (s: string, w: number, size = 8, strong = false) => {
    const out: string[] = [];
    const face = strong ? bold : font;
    for (const para of clean(s).split("\n")) {
      let current = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = current ? `${current} ${word}` : word;
        if (face.widthOfTextAtSize(next, size) <= w) {
          current = next;
          continue;
        }
        if (current) {
          out.push(current);
          current = "";
        }
        for (const char of Array.from(word)) {
          if (current && face.widthOfTextAtSize(current + char, size) > w) {
            out.push(current);
            current = "";
          }
          current += char;
        }
      }
      out.push(current);
    }
    return out.length ? out : [""];
  };
  const stamp = new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Manila",
  }).format(new Date(r.generatedAt));
  function newPage(section: string) {
    page = doc.addPage([width, height]);
    page.drawRectangle({
      x: 0,
      y: height - 77,
      width,
      height: 77,
      color: navy,
    });
    page.drawImage(crest, { x: margin, y: height - 62, width: 44, height: 44 });
    page.drawImage(wordmark, {
      x: 96,
      y: height - 73,
      width: 193,
      height: 71.4,
    });
    page.drawRectangle({ x: 0, y: height - 80, width, height: 3, color: gold });
    text("FINANCE REPORT", width - 228, height - 32, 14, true, cream);
    text(
      `${r.options.start} to ${r.options.end}`,
      width - 228,
      height - 53,
      9,
      false,
      cream,
    );
    y = height - 107;
    text(section, margin, y, 15, true);
    y -= 20;
  }
  function paragraph(s: string, size = 8.5) {
    for (const row of wrap(s, content, size)) {
      if (y < bottom + 14) newPage("Report notes - continued");
      text(row, margin, y, size);
      y -= size + 4;
    }
    y -= 6;
  }
  function table(title: string, columns: Column[], rows: Row[], note = "") {
    const weights = columns.reduce((n, c) => n + c.weight, 0),
      sizes = columns.map((c) => (content * c.weight) / weights),
      size = 7.8,
      leading = 10;
    if (!rows.length)
      rows = [
        {
          cells: [
            "No records for this section.",
            ...columns.slice(1).map(() => "-"),
          ],
        },
      ];
    const labels = columns.map((c, i) =>
      wrap(c.label, sizes[i] - 12, 7.8, true),
    );
    const headerHeight = Math.max(...labels.map((l) => l.length)) * 10 + 12;
    const preparedRows = rows.map((row) =>
      columns.map((_, i) =>
        wrap(row.cells[i] ?? "", sizes[i] - 12, size, row.total),
      ),
    );
    const estimate =
      46 +
      (note ? wrap(note, content, 8).length * 12 + 6 : 0) +
      headerHeight +
      preparedRows.reduce(
        (n, c) => n + Math.max(...c.map((l) => l.length)) * leading + 6,
        0,
      );
    if (rows.length <= 12 && estimate <= y - bottom) {
      y -= 26;
      text(title, margin, y, 15, true);
      y -= 20;
    } else newPage(title);
    if (note) paragraph(note, 8);
    function heading() {
      const h = headerHeight;
      page.drawRectangle({
        x: margin,
        y: y - h + 4,
        width: content,
        height: h,
        color: cream,
      });
      let x = margin;
      labels.forEach((ls, i) => {
        ls.forEach((s, j) => text(s, x + 6, y - 8 - j * 10, 7.8, true));
        x += sizes[i];
      });
      y -= h;
    }
    heading();
    let rowNumber = 0;
    for (const row of rows) {
      const cells = preparedRows[rowNumber];
      let cursor = 0;
      const max = Math.max(...cells.map((c) => c.length));
      while (cursor < max) {
        const followingTotal = rows[rowNumber + 1]?.total
          ? Math.max(...preparedRows[rowNumber + 1].map((l) => l.length)) *
              leading +
            6
          : 0;
        const together = (max - cursor) * leading + 6 + followingTotal;
        if (
          y - bottom < leading + 6 ||
          (followingTotal > 0 &&
            together <= height - 127 - headerHeight - bottom &&
            together > y - bottom)
        ) {
          newPage(`${title} - continued`);
          heading();
        }
        const take = Math.max(
            1,
            Math.min(max - cursor, Math.floor((y - bottom - 6) / leading)),
          ),
          h = take * leading + 6;
        if (row.total || rowNumber % 2 === 1)
          page.drawRectangle({
            x: margin,
            y: y - h + 3,
            width: content,
            height: h,
            color: row.total ? cream : rgb(0.98, 0.975, 0.955),
          });
        let x = margin;
        cells.forEach((ls, i) => {
          ls.slice(cursor, cursor + take).forEach((s, j) => {
            const at = columns[i].right
              ? x +
                sizes[i] -
                6 -
                (row.total ? bold : font).widthOfTextAtSize(s, size)
              : x + 6;
            text(s, at, y - 8 - j * leading, size, row.total);
          });
          x += sizes[i];
        });
        page.drawLine({
          start: { x: margin, y: y - h + 3 },
          end: { x: width - margin, y: y - h + 3 },
          thickness: 0.35,
          color: line,
        });
        y -= h;
        cursor += take;
        if (cursor < max) {
          newPage(`${title} - continued`);
          heading();
        }
      }
      rowNumber++;
    }
  }
  const col = (label: string, weight: number, right = false): Column => ({
    label,
    weight,
    right,
  });
  const row = (...cells: string[]): Row => ({ cells });
  const category = (id: string) =>
    r.categories.find((c) => c.id === id)?.name || "Unknown category";
  const amountPair = (
    label: string,
    value: number,
    x: number,
    at: number,
    w: number,
    strong = false,
  ) => {
    text(label, x, at, 9, strong);
    const s = money(value);
    text(
      s,
      x + w - (strong ? bold : font).widthOfTextAtSize(s, 10),
      at,
      10,
      strong,
    );
  };

  newPage("Finance management report");
  paragraph(
    `${r.options.period[0].toUpperCase() + r.options.period.slice(1)} view | Obligations and settlement payments as of ${displayDate(r.options.asOf)}`,
  );
  paragraph(
    `Generated ${stamp} Manila | Prepared by ${r.preparedBy} | ${r.sample ? "FICTIONAL SAMPLE DATA" : "Shared finance records"}`,
  );
  const cards = [
    ["Income", r.cash.income],
    ["Business expenses", r.cash.expense],
    ["Net income", r.cash.net],
    ["Owner cash payouts", r.paidToOwners],
  ] as const;
  const gap = 12,
    cardW = (content - gap * 3) / 4,
    cardTop = y;
  cards.forEach(([label, value], i) => {
    const x = margin + i * (cardW + gap);
    page.drawRectangle({
      x,
      y: cardTop - 62,
      width: cardW,
      height: 62,
      color: i === 2 ? navy : cream,
    });
    text(label, x + 12, cardTop - 19, 9, true, i === 2 ? cream : navy);
    const val = money(value);
    const size = Math.min(17, (cardW - 24) / bold.widthOfTextAtSize(val, 1));
    text(val, x + 12, cardTop - 46, size, true, i === 2 ? cream : navy);
  });
  y -= 88;
  const half = (content - 38) / 2,
    top = y;
  text("Business cash calculation", margin, y, 11, true);
  y -= 25;
  for (const [label, value, strong] of [
    ["Total income", r.cash.income, false],
    ["Operating expenses", r.cash.operating, false],
    ["Fixed-bill payments", r.cash.fixed, false],
    ["Installment payments", r.cash.installment, false],
    ["Total business expenses", r.cash.expense, true],
    ["NET INCOME", r.cash.net, true],
    ["Distributable income", r.cash.distributable, false],
    ["Loss shown separately", Math.max(0, -r.cash.net), false],
  ] as const) {
    amountPair(label, value, margin, y, half, strong);
    y -= 25;
  }
  const leftBottom = y;
  y = top;
  const right = margin + half + 38;
  text("Owner allocation for the selected period", right, y, 11, true);
  y -= 25;
  for (const [name, percent] of [
    ["Genesis", 40],
    ["Ken", 40],
    ["Jeremy", 20],
  ] as const) {
    amountPair(`${name} - ${percent}%`, r.shares[name], right, y, half);
    y -= 25;
  }
  amountPair(
    "Total allocated",
    Object.values(r.shares).reduce((a, b) => a + b, 0),
    right,
    y,
    half,
    true,
  );
  y -= 31;
  amountPair("Cash after owner payouts", r.retained, right, y, half, true);
  y -= 22;
  for (const s of wrap(
    "Cash after owner payouts is period net income less actual owner payouts. It is not an opening or bank balance.",
    half,
    8,
  )) {
    text(s, right, y, 8);
    y -= 11;
  }
  y = Math.min(leftBottom, y) - 12;
  paragraph(
    "Payments are deducted once using their actual payment dates. Owner payouts do not reduce business net income. Fixed-bill and installment balances below are tracked separately from period cash spending.",
    8,
  );
  paragraph(
    "Period owner allocations are indicative. Settlement entitlements use the entire calendar month, with no loss carryforward. Genesis and Ken are rounded to centavos; Jeremy receives the remainder.",
    8,
  );

  newPage("Cash flow and spending");
  paragraph(
    "Graphs use the selected reporting range. Detailed category totals and daily figures follow.",
    8,
  );
  const comparison = [
    { name: "Income", value: r.cash.income, color: gold },
    { name: "Business expenses", value: r.cash.expense, color: burgundy },
    { name: "Owner cash payouts", value: r.paidToOwners, color: navy },
  ];
  const comparisonMin = Math.min(0, ...comparison.map((p) => p.value));
  const maximum = Math.max(1, ...comparison.map((p) => p.value));
  const comparisonWidth = content - 280;
  const comparisonX = (n: number) =>
    margin +
    140 +
    (comparisonWidth * (n - comparisonMin)) / (maximum - comparisonMin);
  page.drawLine({
    start: { x: comparisonX(0), y: y + 12 },
    end: { x: comparisonX(0), y: y - 64 },
    thickness: 0.6,
    color: gold,
  });
  text("0", comparisonX(0) - 2, y + 16, 7);
  for (const p of comparison) {
    text(p.name, margin, y, 9, true);
    page.drawRectangle({
      x: Math.min(comparisonX(0), comparisonX(p.value)),
      y: y - 3,
      width: Math.abs(comparisonX(p.value) - comparisonX(0)),
      height: 13,
      color: p.color,
    });
    text(money(p.value), width - margin - 120, y, 9);
    y -= 26;
  }
  y -= 12;
  text("Largest expense categories", margin, y, 11, true);
  y -= 23;
  const topCategories = r.expenseCategories.slice(0, 5),
    maxExpense = Math.max(1, ...topCategories.map((c) => c.amount));
  if (!topCategories.length) {
    text("No business expenses in this range.", margin, y);
    y -= 20;
  }
  for (const c of topCategories) {
    const label = wrap(c.name, 205, 8.2)[0];
    text(label, margin, y, 8.2);
    page.drawRectangle({
      x: margin + 215,
      y: y - 3,
      width: ((content - 350) * c.amount) / maxExpense,
      height: 11,
      color: burgundy,
    });
    text(money(c.amount), width - margin - 120, y, 8.2);
    y -= 23;
  }
  y -= 10;
  text("Net income trend", margin, y, 11, true);
  y -= 15;
  const grouped = new Map<string, number>();
  for (const [i, d] of r.daily.entries()) {
    const key =
      r.daily.length > 62
        ? d.date.slice(0, 7)
        : r.daily.length > 31
          ? r.daily[i - (i % 7)].date
          : d.date;
    grouped.set(key, (grouped.get(key) || 0) + d.net);
  }
  const series = [...grouped],
    chartH = Math.min(97, y - bottom - 24),
    maxNet = Math.max(1, ...series.map((s) => Math.abs(s[1]))),
    base = y - chartH / 2;
  page.drawLine({
    start: { x: margin, y: base },
    end: { x: width - margin, y: base },
    thickness: 0.6,
    color: line,
  });
  const step = content / Math.max(1, series.length);
  text(`Scale: +/- ${money(maxNet)}`, width - margin - 180, y + 15, 7.5);
  series.forEach(([key, n], i) => {
    const h = (Math.abs(n) / maxNet) * (chartH / 2 - 5);
    page.drawRectangle({
      x: margin + i * step + 2,
      y: n >= 0 ? base : base - h,
      width: Math.max(1, step - 4),
      height: Math.max(0.3, h),
      color: n >= 0 ? gold : burgundy,
    });
    if (
      i === 0 ||
      i === series.length - 1 ||
      i % Math.max(1, Math.ceil(series.length / 6)) === 0
    )
      text(
        key.length === 7 ? key.slice(2) : key.slice(5),
        margin + i * step,
        y - chartH - 12,
        6.5,
      );
  });
  text(
    "Gold: positive net. Burgundy: loss. Zero line shown. Daily, seven-day, or monthly groups according to range length.",
    margin,
    bottom + 2,
    7,
  );
  y = bottom;

  table(
    "Income and expense categories",
    [
      col("Type / category", 56),
      col("Entries", 10, true),
      col("Amount", 19, true),
      col("% of type total", 15, true),
    ],
    [
      ...r.incomeCategories.map((c) =>
        row(
          `Income / ${c.name}`,
          String(c.count),
          money(c.amount),
          `${r.cash.income ? ((c.amount / r.cash.income) * 100).toFixed(2) : "0.00"}%`,
        ),
      ),
      {
        cells: [
          "TOTAL INCOME",
          String(r.income.length),
          money(r.cash.income),
          r.cash.income ? "100.00%" : "0.00%",
        ],
        total: true,
      },
      ...r.expenseCategories.map((c) =>
        row(
          `Expense / ${c.name}`,
          String(c.count),
          money(c.amount),
          `${r.cash.expense ? ((c.amount / r.cash.expense) * 100).toFixed(2) : "0.00"}%`,
        ),
      ),
      {
        cells: [
          "TOTAL EXPENSES",
          String(r.expenses.length),
          money(r.cash.expense),
          r.cash.expense ? "100.00%" : "0.00%",
        ],
        total: true,
      },
    ],
  );
  table(
    "Daily cash movement",
    [
      col("Date", 12),
      col("Income", 12, true),
      col("Operating", 11, true),
      col("Fixed", 10, true),
      col("Installments", 11, true),
      col("Total expenses", 12, true),
      col("Net", 12, true),
      col("Owner payouts", 12, true),
      col("After owners", 12, true),
    ],
    [
      ...r.daily.map((d) =>
        row(
          d.date,
          money(d.income),
          money(d.operating),
          money(d.fixed),
          money(d.installment),
          money(d.expense),
          money(d.net),
          money(d.ownerPaid),
          money(d.retained),
        ),
      ),
      {
        cells: [
          "TOTAL",
          money(r.cash.income),
          money(r.cash.operating),
          money(r.cash.fixed),
          money(r.cash.installment),
          money(r.cash.expense),
          money(r.cash.net),
          money(r.paidToOwners),
          money(r.retained),
        ],
        total: true,
      },
    ],
    "Business net = income less all business expenses. After owners = business net less owner cash payouts. These are period movements, not cash-account balances.",
  );
  table(
    "Income transaction details",
    [
      col("Business date", 13),
      col("Income category", 24),
      col("Amount", 15, true),
      col("Notes", 48),
    ],
    [
      ...r.income.map((i) =>
        row(
          i.business_date,
          category(i.category_id),
          money(i.amount_cents),
          i.notes || "-",
        ),
      ),
      { cells: ["TOTAL INCOME", "", money(r.cash.income), ""], total: true },
    ],
  );
  table(
    "Expense payment details",
    [
      col("Paid on", 10),
      col("Category", 13),
      col("Type", 10),
      col("Amount", 12, true),
      col("Bill / agreement", 17),
      col("Due month", 10),
      col("Reference", 13),
      col("Notes", 25),
    ],
    [
      ...r.expenses.map((e) => {
        const b = r.billRegister.find((b) => b.id === e.fixed_bill_id),
          a = r.installmentRegister.find((a) => a.id === e.installment_id);
        return row(
          e.paid_on,
          category(e.category_id),
          e.payment_kind === "fixed"
            ? "Fixed bill"
            : e.payment_kind === "installment"
              ? "Installment"
              : "Operating",
          money(e.amount_cents),
          b ? `${b.code}\n${b.name}` : a ? `${a.code}\n${a.name}` : "-",
          e.due_month?.slice(0, 7) || "-",
          e.reference || "-",
          `${e.notes || "-"}${e.staff_payment_id ? "\nLinked wages payment" : ""}`,
        );
      }),
      {
        cells: [
          "TOTAL EXPENSES",
          "",
          "",
          money(r.cash.expense),
          "",
          "",
          "",
          "",
        ],
        total: true,
      },
    ],
    "Every recorded payment is shown once. Payments for a different due month remain in the cash period containing their actual payment date.",
  );
  table(
    "Fixed bills for report months",
    [
      col("Due month", 11),
      col("Bill / category", 27),
      col("Due date", 12),
      col("Expected", 12, true),
      col("Paid to date", 12, true),
      col("Unpaid", 12, true),
      col("Overdue", 12, true),
      col("Status / credit", 17),
    ],
    r.bills.map((b) =>
      row(
        b.month.slice(0, 7),
        `${b.bill.code} - ${b.bill.name}\n${category(b.bill.category_id)}${b.bill.notes ? "\n" + b.bill.notes : ""}`,
        b.due || "-",
        money(b.expected),
        money(b.paid),
        money(b.unpaid),
        money(b.overdue),
        `${b.status}${b.paid > b.expected ? "\nCredit " + money(b.paid - b.expected) : ""}`,
      ),
    ),
    `Expected amounts use the effective terms for each report month. Paid, unpaid and overdue use payments through ${r.options.asOf}, including payments outside this report's cash range. Due dates clamp to month-end.`,
  );
  table(
    "Installment agreement terms",
    [
      col("Code / agreement", 24),
      col("Category", 15),
      col("Agreed total", 13, true),
      col("Monthly", 12, true),
      col("First due", 12),
      col("Final payment", 13, true),
      col("Notes", 26),
    ],
    r.installments.map((a) =>
      row(
        `${a.agreement.code}\n${a.agreement.name}`,
        category(a.agreement.category_id),
        money(a.agreement.total_cents),
        money(a.agreement.monthly_cents),
        a.agreement.first_due,
        money(a.finalPayment),
        a.agreement.notes || "-",
      ),
    ),
    "The agreed total includes interest. The final scheduled payment is adjusted to the remaining agreed amount.",
  );
  table(
    "Installment payments and balances",
    [
      col("Agreement", 19),
      col("Scheduled in range", 13, true),
      col("Cash paid in range", 13, true),
      col("Total paid to date", 13, true),
      col("Remaining", 13, true),
      col("Overdue", 13, true),
      col("Next unpaid due", 13),
      col("Status / credit", 18),
    ],
    r.installments.map((a) =>
      row(
        `${a.agreement.code}\n${a.agreement.name}`,
        money(a.scheduled),
        money(a.periodPaid),
        money(a.paid),
        money(a.remaining),
        money(a.overdue),
        a.next || "-",
        `${a.status}${a.paid > a.agreement.total_cents ? "\nCredit " + money(a.paid - a.agreement.total_cents) : ""}`,
      ),
    ),
    `Cash paid in range is already included in business expenses. Cumulative progress, overdue and next unpaid dates are calculated as of ${r.options.asOf}.`,
  );
  table(
    "Monthly owner settlement",
    [
      col("Calendar month", 14),
      col("Owner", 10),
      col("Full-month net", 13, true),
      col("Share", 6, true),
      col("Gross entitlement", 13, true),
      col("Capital withheld", 13, true),
      col("Recovery %", 8, true),
      col("Cash paid", 12, true),
      col("Still payable", 12, true),
      col("Status", 11),
    ],
    r.ownerMonths.flatMap((m) =>
      m.owners.map((o) =>
        row(
          m.month.slice(0, 7),
          o.owner,
          money(m.net),
          `${o.share}%`,
          money(o.entitlement),
          money(o.withheld),
          o.recoveryRateBps === null
            ? "-"
            : (o.recoveryRateBps / 100).toFixed(2) + "%",
          money(o.paid),
          money(o.balance),
          o.status,
        ),
      ),
    ),
    `Each report month uses its ENTIRE calendar month's net income. Confirmed owner settlements use frozen shares and capital deductions; source changes require admin review. Still payable = gross entitlement less confirmed capital withholding less actual cash payouts through ${r.options.asOf}. Withholding retains funds in Gardens; it is not another expense or cash payment. Negative balances flag overpayments. Loss months distribute zero; no loss carryforward.`,
  );
  table(
    "Partner-funded purchases — Gardens owes partners",
    [
      col("Purchase / agreement", 24),
      col("Partner", 12),
      col("Purchased", 12),
      col("Agreed total", 13, true),
      col("Reimbursed", 13, true),
      col("Remaining", 13, true),
      col("Next due / status", 18),
    ],
    r.partnerPurchases.map((v) =>
      row(
        v.agreement.name + "\n" + v.agreement.code,
        v.owner,
        v.purchased_on,
        money(v.agreement.total_cents),
        money(v.paid),
        money(v.remaining),
        (v.next || "Completed") + "\n" + v.status,
      ),
    ),
    `Balances as of ${r.options.asOf}. Registering a purchase creates no expense. Actual reimbursements already appear once in installment expenses; do not deduct them again.`,
  );
  table(
    "Capital supplier payments — separate from operating profit",
    [
      col("Supplier / purpose", 29),
      col("Total", 15, true),
      col("Paid on", 12),
      col("Recovery starts", 12),
      col("Account / reference", 20),
      col("Status", 12),
    ],
    r.partnerFundings.map((f) =>
      row(
        f.supplier + "\n" + f.purpose,
        money(f.total_cents),
        f.funded_on || "Not paid",
        f.start_month,
        f.funding_detail
          ? [f.funding_detail.account, f.funding_detail.reference]
              .filter(Boolean)
              .join("\n")
          : "-",
        f.state,
      ),
    ),
    `Capital advances reduce account funds when paid. They do not reduce operating profit, create owner cash payouts or automatically increase ROI capital. Drafts move no money. Voided entries are corrections, not actual refunds.`,
  );
  table(
    "Capital amounts owed by partners",
    [
      col("Partner", 12),
      col("Purpose", 30),
      col("Allocated", 15, true),
      col("Recovered", 15, true),
      col("Remaining", 15, true),
      col("Funding status", 13),
    ],
    r.partnerDebts.map((d) =>
      row(
        d.owner,
        d.funding.purpose,
        money(d.amount_cents),
        money(d.recovered),
        money(d.remaining),
        d.funding.state,
      ),
    ),
    `Recoveries include active confirmed settlements effective through ${r.options.asOf}. Debts stay separate from amounts Gardens owes partners. Draft allocations are awaiting funding, not active debt.`,
  );
  table(
    "Capital cash movement in the reporting period",
    [col("Calculation", 70), col("Amount", 30, true)],
    [
      row("Business net after actual owner cash payouts", money(r.retained)),
      row(
        "Less: capital supplier payments (not operating expenses)",
        money(r.partnerCapitalOut),
      ),
      {
        cells: [
          "AFTER OWNER PAYOUTS AND CAPITAL ADVANCES",
          money(r.afterCapitalAdvances),
        ],
        total: true,
      },
    ],
    "These are period movements, not an account balance. Withholding money from an owner share creates no extra cash receipt. Transfers, opening funds and other balance corrections remain in the account section.",
  );
  table(
    "Owner settlement confirmation and correction history",
    [
      col("Month", 12),
      col("Confirmed at (Manila)", 24),
      col("Net used", 16, true),
      col("Status", 12),
      col("Correction reason", 36),
    ],
    r.partnerSettlements.map((s) =>
      row(
        s.month,
        new Date(s.confirmed_at).toLocaleString("en-PH", {
          timeZone: "Asia/Manila",
        }),
        money(s.net_cents),
        s.reversed_at ? "Reversed" : "Confirmed",
        s.reversal_reason || "-",
      ),
    ),
    "Original statements remain immutable. Reversal restores their debt recovery without deleting owner cash payments. Replacements are separate confirmed versions.",
  );
  table(
    "Owner cash payout details",
    [
      col("Paid on", 12),
      col("Owner", 12),
      col("Settlement month", 14),
      col("Amount", 15, true),
      col("Reference", 21),
      col("Notes", 26),
    ],
    [
      ...r.payouts.map((p) =>
        row(
          p.paid_on,
          p.owner,
          p.settlement_month.slice(0, 7),
          money(p.amount_cents),
          p.reference || "-",
          p.notes || "-",
        ),
      ),
      {
        cells: ["TOTAL PAID", "", "", money(r.paidToOwners), "", ""],
        total: true,
      },
    ],
    "This log uses actual payout dates in the selected reporting range. Owner payouts do not reduce business net income.",
  );
  newPage("Capital and ROI as of report date");
  paragraph(
    `As of ${displayDate(r.options.asOf)} | ROI basis starts ${r.roi.start ? displayDate(r.roi.start) : "when the first capital contribution is recorded"}.`,
    9,
  );
  const roiRows: [string, string][] = [
    ["Capital invested", money(r.roi.invested)],
    ["Business income since ROI start", money(r.roi.income)],
    ["Business expenses since ROI start", money(r.roi.expense)],
    ["Cash net since ROI start", money(r.roi.net)],
    ["Marked capital purchase add-back", money(r.roi.capitalCosts)],
    ["Cash return toward capital recovery", money(r.roi.returned)],
    [
      "ROI percentage",
      r.roi.percent === null
        ? "Not available - no capital"
        : `${r.roi.percent.toFixed(2)}%`,
    ],
    ["Capital still to recover", money(r.roi.remaining)],
    ["Surplus over capital", money(r.roi.surplus)],
  ];
  const roiTop = y;
  for (const [i, [label, value]] of roiRows.entries()) {
    const x = margin + (i >= 5 ? (content + 30) / 2 : 0),
      at = roiTop - (i % 5) * 28,
      w = (content - 30) / 2;
    text(label, x, at, 8.5);
    text(value, x + w - bold.widthOfTextAtSize(value, 9), at, 9, true);
  }
  y = roiTop - 5 * 28 - 8;
  paragraph(
    "ROI return = cash net since the first capital contribution plus expenses marked as capital purchases. Add-backs affect ROI only; the business cash-expense and net-income figures are unchanged. Capital contributions are not operating income.",
    8,
  );
  paragraph(
    "Owner recovery below compares each contribution with actual owner payouts since the ROI start. It is separate from the business ROI percentage and monthly share entitlement.",
    8,
  );
  table(
    "Owner capital recovery",
    [
      col("Owner", 24),
      col("Contributed to date", 23, true),
      col("Actual payouts since ROI start", 23, true),
      col("Unrecovered capital", 23, true),
      col("Recovered", 18, true),
    ],
    r.roi.owners.map((o) =>
      row(
        o.owner,
        money(o.contribution),
        money(o.paid),
        money(o.remaining),
        o.percent === null ? "-" : `${o.percent.toFixed(2)}%`,
      ),
    ),
  );
  table(
    "Capital contribution details",
    [
      col("Invested on", 13),
      col("Owner", 12),
      col("Amount", 16, true),
      col("Reference", 23),
      col("Notes", 36),
    ],
    [
      ...r.capital.map((c) =>
        row(
          c.invested_on,
          c.owner,
          money(c.amount_cents),
          c.reference || "-",
          c.notes || "-",
        ),
      ),
      {
        cells: ["TOTAL CAPITAL", "", money(r.roi.invested), "", ""],
        total: true,
      },
    ],
    `All contributions through ${r.options.asOf}; separate from the selected period's business income.`,
  );
  table(
    "Capital purchase adjustments used in ROI",
    [
      col("Paid on", 12),
      col("Expense category", 20),
      col("Amount", 15, true),
      col("Reason for adjustment", 30),
      col("Reference / notes", 28),
    ],
    [
      ...r.capitalCosts.map((c) =>
        row(
          c.expense.paid_on,
          category(c.expense.category_id),
          money(c.expense.amount_cents),
          c.reason,
          `${c.expense.reference || "-"}\n${c.expense.notes || "-"}`,
        ),
      ),
      {
        cells: ["TOTAL ADD-BACK", "", money(r.roi.capitalCosts), "", ""],
        total: true,
      },
    ],
    "These recorded expenses remain deducted from business net income. They are added back only in the cumulative ROI recovery calculation.",
  );
  if (r.warnings.length) {
    table(
      "Items to review",
      [col("Data checks", 100)],
      r.warnings.map((w) => row(w)),
      "Flags do not change or exclude any transaction. Review the source records in the app.",
    );
  }
  if (r.balanceData) {
    const settings = r.balanceData.settings,
      b = r.balances;
    if (settings && b?.available) {
      table(
        "Cash, bank and booking balances",
        [
          col("Account", 45),
          col("Opening balance", 25, true),
          col("Recorded balance", 30, true),
        ],
        Object.entries(ACCOUNTS)
          .map(([id, label]) =>
            row(
              label,
              money(settings[id as CashAccount]),
              money(b.balances[id as CashAccount]),
            ),
          )
          .concat([
            { cells: ["TOTAL TRACKED FUNDS", "", money(b.total)], total: true },
          ]),
        `As of ${r.options.asOf}. Opening balances are at the start of ${settings.start_date}. Booking balance includes manually tracked withdrawable funds only. These balances are separate from business profit. Unassigned receipts ${money(b.unassignedIn)} and unassigned payments ${money(b.unassignedOut)} are excluded until assigned. Income refund corrections ${money(b.unassignedRefunds)} require manual account handling and are not offset against receipts. Not a live bank or booking-system feed.`,
      );
      table(
        "Account assignments through the as-of date",
        [
          col("Date", 12),
          col("Finance entry", 28),
          col("Received into / paid from", 32),
          col("Amount", 18, true),
          col("Direction", 10),
        ],
        b.entries.flatMap((e) =>
          e.allocations.map((a) =>
            row(
              a.posted_on || e.date,
              `${e.label}\n${e.reference || e.notes}`,
              ACCOUNTS[a.account],
              money(a.amount_cents),
              e.kind === "income" ? "In" : "Out",
            ),
          ),
        ),
        "Each assignment links to an existing finance entry. Splits allocate a portion of that entry; they do not create additional income or expenses.",
      );
      table(
        "Fund movements through the as-of date",
        [
          col("Date / type", 16),
          col("From", 19),
          col("To", 19),
          col("Amount", 16, true),
          col("Reference / reason", 30),
        ],
        r.balanceData.movements
          .filter((m) => m.moved_on <= r.options.asOf)
          .map((m) =>
            row(
              `${m.moved_on}\n${m.kind}`,
              m.from_account ? ACCOUNTS[m.from_account] : "Outside funds",
              m.to_account ? ACCOUNTS[m.to_account] : "Outside funds",
              money(m.amount_cents),
              `${m.reference || "-"}\n${m.reason}`,
            ),
          ),
        "Transfers preserve combined tracked funds. Funding and corrections change balances only; recorded business income, expenses, ROI and owner shares remain unchanged.",
      );
    } else
      table(
        "Cash, bank and booking balances",
        [col("Status", 100)],
        [
          row(
            settings
              ? "The selected as-of date is before the opening date."
              : "Opening balances have not been configured. Historical finance records are unassigned; no cash or bank balance has been assumed.",
          ),
        ],
      );
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    page.drawLine({
      start: { x: margin, y: 37 },
      end: { x: width - margin, y: 37 },
      thickness: 0.5,
      color: line,
    });
    text(
      `${r.sample ? "FICTIONAL SAMPLE | " : ""}Private finance report | ${stamp} Manila`,
      margin,
      24,
      6.8,
      false,
      muted,
    );
    text(
      `${i + 1} / ${pages.length}`,
      width - margin - 40,
      24,
      7.5,
      false,
      muted,
    );
  });
  if (replaced) {
    page = pages[pages.length - 1];
    text(
      "Some symbols unavailable in the embedded font are shown as ?. Original records remain in the app.",
      margin,
      43,
      6.5,
      false,
      muted,
    );
  }
  return doc.save();
}
