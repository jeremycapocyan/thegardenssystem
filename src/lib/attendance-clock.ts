import type { SupabaseClient } from "@supabase/supabase-js";
import {
  attendanceRateKey,
  normalizeEmployeeCode,
  validPin,
  validUuid,
  verifyAttendancePin,
} from "./attendance-pin";
const reply = (message: string, status = 400) =>
  Response.json(
    { message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...(status === 429 ? { "Retry-After": "900" } : {}),
      },
    },
  );
export async function handlePinClock(
  request: Request,
  api: SupabaseClient,
  secret: string,
  ip: string,
) {
  if (secret.length < 32)
    return reply(
      "PIN attendance is not configured yet. Use employee sign-in.",
      503,
    );
  let attempt: string | null = null;
  const finish = async (success: boolean) => {
    if (attempt) {
      const id = attempt;
      attempt = null;
      await api.rpc("garden_pin_finish", { p_attempt: id, p_success: success });
    }
  };
  try {
    if (Number(request.headers.get("content-length") || 0) > 4096)
      return reply("The attendance request is too large.", 413);
    const text = await request.text();
    if (text.length > 4096)
      return reply("The attendance request is too large.", 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      return reply("Enter your employee code and six-digit PIN.");
    }
    if (!body || typeof body !== "object")
      return reply("Enter your employee code and six-digit PIN.");
    const code = normalizeEmployeeCode(body.employee_code);
    if (
      !code ||
      !validPin(body.pin) ||
      !validUuid(body.court) ||
      !validUuid(body.idempotency_key) ||
      !["clock_in", "clock_out"].includes(String(body.action))
    )
      return reply(
        "Scan a valid court QR, enter your employee code and six-digit PIN, then choose Time In or Time Out.",
      );
    const court = await api.rpc("garden_court_code_active", {
      p_court: body.court,
    });
    if (court.error)
      return reply("Attendance is temporarily unavailable. Try again.", 503);
    if (!court.data)
      return reply(
        "This court QR is no longer valid. Scan the current printed code.",
        410,
      );
    const limit = await api.rpc("garden_pin_reserve", {
      p_ip: attendanceRateKey(secret, "ip", ip),
      p_code: attendanceRateKey(secret, "code", code),
    });
    if (limit.error)
      return reply("Attendance is temporarily unavailable. Try again.", 503);
    if (!limit.data?.allowed)
      return reply(
        "Too many unsuccessful attempts. Wait fifteen minutes or use employee sign-in.",
        429,
      );
    attempt = limit.data.attempt_id;
    const lookup = await api.rpc("garden_pin_lookup", { p_code: code });
    if (lookup.error) {
      await finish(true);
      return reply("Attendance is temporarily unavailable. Try again.", 503);
    }
    const credential = lookup.data;
    const correct = await verifyAttendancePin(
      body.pin,
      credential?.salt || "0".repeat(32),
      credential?.pin_hash || "0".repeat(128),
    );
    if (!credential || !correct) {
      await finish(false);
      return reply(
        "Employee code or PIN is incorrect, or clock access is unavailable.",
        401,
      );
    }
    await finish(true);
    const result = await api.rpc("garden_clock_by_pin", {
      p_employee: credential.employee_id,
      p_version: credential.version,
      p_court: body.court,
      p_action: body.action,
      p_nonce: body.idempotency_key,
    });
    if (result.error)
      return reply(
        result.error.code === "P0001"
          ? result.error.message
          : "Attendance could not be confirmed. Your account or PIN may have changed. Retry or use employee sign-in.",
        result.error.code === "42501"
          ? 403
          : result.error.code === "P0001"
            ? 409
            : 503,
      );
    return Response.json(
      {
        name: result.data.name,
        action: result.data.action,
        at: result.data.at,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    await finish(true);
    return reply(
      "Attendance could not be confirmed. Retry the same action before making another punch.",
      503,
    );
  }
}
