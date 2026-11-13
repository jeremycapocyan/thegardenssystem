import { staffAuth, staffReply, staffService } from "@/lib/staff-server";
import { hashAttendancePin, validPin } from "@/lib/attendance-pin";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const ctx = await staffAuth(request, "employee");
  if (ctx instanceof Response) return ctx;
  try {
    if (Number(request.headers.get("content-length") || 0) > 2048)
      return staffReply("The PIN request is too large.", 413);
    const body = await request.json();
    if (!validPin(body?.pin) || body.pin !== body.confirmation)
      return staffReply("Enter the same six-digit PIN in both fields.");
    const hashed = await hashAttendancePin(body.pin);
    const result = await staffService().rpc("garden_set_attendance_pin", {
      p_actor: ctx.profile.id,
      p_salt: hashed.salt,
      p_hash: hashed.hash,
    });
    if (result.error)
      return staffReply(
        "Your PIN could not be saved. Check that your employee account is active.",
        403,
      );
    return staffReply(
      "Attendance PIN saved. Use your employee code and this PIN after scanning the court QR.",
      200,
    );
  } catch {
    return staffReply(
      "Your PIN could not be saved. Reconnect and try again.",
      503,
    );
  }
}
