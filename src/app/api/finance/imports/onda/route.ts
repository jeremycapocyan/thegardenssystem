import { ondaAuth, ondaError, ondaReply } from "@/lib/onda-server";
import { staffService } from "@/lib/staff-server";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const ctx = await ondaAuth(request);
  if (ctx instanceof Response) return ctx;
  const offset = Number(new URL(request.url).searchParams.get("offset") || 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
    return ondaReply("Choose a valid history page.");
  try {
    const r = await staffService()
      .from("garden_onda_imports")
      .select(
        "id,filename,actor_id,created_at,confirmed_at,expires_at,state,result,parsed->start,parsed->end,parsed->net,actor:garden_profiles!actor_id(display_name)",
      )
      .order("created_at", { ascending: false })
      .order("id")
      .range(offset, offset + 19);
    if (r.error) throw Error("Import history could not be loaded.");
    return Response.json(
      {
        imports: r.data,
        next_offset: r.data.length === 20 ? offset + 20 : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return ondaError(e);
  }
}
