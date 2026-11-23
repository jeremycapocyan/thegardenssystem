import { ondaAuth, ondaError, prepareOnda } from "@/lib/onda-server";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const ctx = await ondaAuth(request);
  if (ctx instanceof Response) return ctx;
  try {
    return Response.json(await prepareOnda(request, ctx.actor), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return ondaError(e);
  }
}
