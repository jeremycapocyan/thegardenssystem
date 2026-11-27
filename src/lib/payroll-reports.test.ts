import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PDFDocument, PageSizes } from "pdf-lib";
import { payrollReportFixture } from "../../scripts/report-fixture";
import { demoPayrollReport } from "./payroll-reports";
import { createPayrollReportPdf } from "./payroll-report-pdf";
import { loadTimesheetPdfAssets } from "./timesheet-pdf-assets";
import {
  sealMailSecret,
  openMailSecret,
  validReportEmail,
  payrollMime,
  postPayrollGmail,
  PAYROLL_SENDER,
} from "./payroll-mail";
test("final report freezes approved earnings, partial payments and advance recovery without double deduction", () => {
  const { data, report } = payrollReportFixture();
  assert.equal(report.statement.gross_cents, 385937);
  assert.equal(report.statement.recovery_cents, 100000);
  assert.equal(report.statement.payable_cents, 285937);
  assert.equal(report.paid_cents, 100000);
  assert.equal(report.balance_cents, 185937);
  assert.equal(report.payment_status, "Partially paid");
  assert.equal(report.statement.snapshot.blockers.length, 0);
  data.cash[1].amount_cents = 200000;
  data.cash[1].funding_account = "bank";
  data.attendance = [];
  data.employees[0].name = "Changed later";
  assert.equal(report.paid_cents, 100000);
  assert(report.employee.name.startsWith("María"));
  const next = demoPayrollReport(data, data.payroll[0].id, randomUUID());
  assert.equal(next.statement.gross_cents, 385937);
  assert.equal(next.paid_cents, 200000);
  assert.equal(next.payments[0].funding_account, "bank");
  data.cash[1].funding_account = "cash";
  assert.equal(next.payments[0].funding_account, "bank");
  assert.throws(
    () => demoPayrollReport(data, randomUUID(), randomUUID()),
    /Finalize payroll/,
  );
});
test("refresh credentials are encrypted with authenticated randomized encryption", () => {
  const key = randomBytes(32).toString("hex"),
    cipher = sealMailSecret("fictional-refresh-token", key);
  assert(!cipher.includes("fictional-refresh-token"));
  assert.equal(openMailSecret(cipher, key), "fictional-refresh-token");
  assert.notEqual(sealMailSecret("fictional-refresh-token", key), cipher);
  assert.throws(() => openMailSecret(cipher, randomBytes(32).toString("hex")));
  assert.throws(() => sealMailSecret("secret", "bad"));
  assert.throws(() => openMailSecret(cipher.slice(0, -2) + "ff", key));
});
test("fixed-template MIME sends only the registered recipient and the exact saved PDF attachment", () => {
  const { report } = payrollReportFixture(),
    pdf = Buffer.from("%PDF-fictional-bytes"),
    nonce = randomUUID(),
    mime = payrollMime(report, pdf, nonce);
  assert(mime.includes(`From: The Gardens Payroll <${PAYROLL_SENDER}>`));
  assert(mime.includes(`To: <${report.employee.email}>`));
  assert(!/^Cc:|^Bcc:/m.test(mime));
  const attachment = mime
    .split("Content-Disposition: attachment;")[1]
    .split("\r\n\r\n")[1]
    .split("\r\n--")[0];
  assert.deepEqual(Buffer.from(attachment, "base64"), pdf);
  for (const email of [
    "wrong",
    "a@example.com\r\nBcc: intruder@example.com",
    "a@example.com,b@example.com",
    "a..b@example.com",
  ])
    assert(!validReportEmail(email));
  assert(validReportEmail("alex+payroll@example.com"));
  report.employee.email = "a@example.com\nBcc: thief@example.com";
  assert.throws(() => payrollMime(report, pdf, nonce), /email/);
});
test("Gmail response handling never retries uncertain sends or claims delivery", async () => {
  let calls = 0;
  const mock = (result: Response | Error) =>
    (async () => {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    }) as typeof fetch;
  assert.equal(
    (
      await postPayrollGmail(
        "fictional",
        "mime",
        mock(Response.json({ id: "message-id" })),
      )
    ).status,
    "sent",
  );
  assert.equal(
    (
      await postPayrollGmail(
        "fictional",
        "mime",
        mock(new Response("", { status: 429 })),
      )
    ).status,
    "failed",
  );
  assert.equal(
    (
      await postPayrollGmail(
        "fictional",
        "mime",
        mock(new Response("", { status: 503 })),
      )
    ).status,
    "unconfirmed",
  );
  assert.equal(
    (
      await postPayrollGmail(
        "fictional",
        "mime",
        mock(new Error("lost response")),
      )
    ).status,
    "unconfirmed",
  );
  assert.equal(calls, 4);
});
test("finalized report PDF has a portrait summary, landscape attendance and overflow payment pages", async () => {
  const { report } = payrollReportFixture(),
    assets = await loadTimesheetPdfAssets(),
    pdf = await PDFDocument.load(await createPayrollReportPdf(report, assets));
  assert.equal(pdf.getPage(0).getWidth(), PageSizes.A4[0]);
  assert.equal(pdf.getPage(0).getHeight(), PageSizes.A4[1]);
  assert(pdf.getPageCount() >= 2);
  assert.equal(pdf.getPages().at(-1)!.getWidth(), PageSizes.A4[1]);
  report.payments = Array.from({ length: 40 }, (_, i) => ({
    paid_on: "2026-11-13",
    amount_cents: 100,
    reference: `Sample reference ${i} with a long reference that should wrap and keep its own row readable.`,
  }));
  const stress = await PDFDocument.load(
    await createPayrollReportPdf(report, assets),
  );
  assert(stress.getPageCount() > pdf.getPageCount());
});
