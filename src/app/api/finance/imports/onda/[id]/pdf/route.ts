import {
  ondaAuth,
  ondaError,
  ondaUuid,
  ondaReply,
  downloadOnda,
} from "@/lib/onda-server";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ondaAuth(request);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!ondaUuid(id)) return ondaReply("Choose a saved import.");
  try {
    return await downloadOnda(id);
  } catch (e) {
    return ondaError(e);
  }
}
