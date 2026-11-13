import { handlePinClock } from "@/lib/attendance-clock";
import { staffReply, staffService } from "@/lib/staff-server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const ip = process.env.VERCEL
      ? request.headers.get("x-real-ip") || "unavailable"
      : "local";
    return await handlePinClock(
      request,
      staffService(),
      process.env.ATTENDANCE_RATE_LIMIT_SECRET || "",
      ip,
    );
  } catch {
    return staffReply(
      "PIN attendance is temporarily unavailable. Use employee sign-in.",
      503,
    );
  }
}
