import {
  ondaAuth,
  ondaError,
  ondaUuid,
  ondaReply,
  refreshOnda,
} from "@/lib/onda-server";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await ondaAuth(request);
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  if (!ondaUuid(id)) return ondaReply("Choose a saved preview.");
  try {
    return Response.json(await refreshOnda(ctx.actor, id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return ondaError(e);
  }
}
