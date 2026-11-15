import "server-only";
import { staffService } from "./staff-server";
import { sha256 } from "./payroll-mail";
import { createPayrollReportPdf } from "./payroll-report-pdf";
import { loadTimesheetPdfAssets } from "./timesheet-pdf-assets";
import type { PayrollReportData } from "./payroll-reports";
export const REPORT_BUCKET = "garden-payroll-reports";
export interface StoredPayrollReport {
  id: string;
  payroll_id: string;
  data: PayrollReportData;
  state: string;
  render_token: string;
  sha256: string;
  file_bytes: number;
}
export async function storedReport(id: string) {
  const found = await staffService()
    .from("garden_payroll_reports")
    .select("*")
    .eq("id", id)
    .single();
  if (found.error) throw Error("Report not found. Refresh report history.");
  return found.data as StoredPayrollReport;
}
export async function downloadReport(r: StoredPayrollReport) {
  if (r.state !== "ready")
    throw Error("The PDF is still being prepared. Refresh report history.");
  const file = await staffService()
    .storage.from(REPORT_BUCKET)
    .download(`${r.id}.pdf`);
  if (file.error) throw Error("The saved PDF is temporarily unavailable.");
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (sha256(bytes) !== r.sha256)
    throw Error("The saved PDF could not be verified. Contact the owner.");
  return bytes;
}
export async function generatePayrollReport(
  actor: string,
  payroll: string,
  id: string,
) {
  const api = staffService(),
    prepared = await api.rpc("garden_prepare_payroll_report", {
      p_actor: actor,
      p_payroll: payroll,
      p_id: id,
    });
  if (prepared.error) throw Error(prepared.error.message);
  const r = prepared.data.report as StoredPayrollReport;
  if (prepared.data.claimed) {
    let bytes = await createPayrollReportPdf(
      r.data,
      await loadTimesheetPdfAssets(),
    );
    const upload = await api.storage
      .from(REPORT_BUCKET)
      .upload(`${id}.pdf`, bytes, {
        contentType: "application/pdf",
        cacheControl: "0",
        upsert: false,
      });
    if (upload.error) {
      // An earlier process may have uploaded the immutable file before its response was lost.
      const existing = await api.storage
        .from(REPORT_BUCKET)
        .download(`${id}.pdf`);
      if (existing.error)
        throw Error(
          "PDF storage could not be confirmed. Retry this report after ninety seconds.",
        );
      bytes = new Uint8Array(await existing.data.arrayBuffer());
    }
    const finished = await api.rpc("garden_finish_payroll_report", {
      p_id: id,
      p_token: r.render_token,
      p_hash: sha256(bytes),
      p_bytes: bytes.length,
    });
    if (finished.error)
      throw Error(
        "PDF creation could not be confirmed. Refresh report history.",
      );
  }
  return { id, state: prepared.data.claimed ? "ready" : r.state };
}
