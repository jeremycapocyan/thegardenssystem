import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  hashAttendancePin,
  verifyAttendancePin,
  validPin,
  normalizeEmployeeCode,
  attendanceRateKey,
} from "./attendance-pin";
import { handlePinClock } from "./attendance-clock";

test("codes normalize while six-digit PINs preserve leading zeros", () => {
  assert.equal(normalizeEmployeeCode(" tg 1 "), "TG-0001");
  assert.equal(normalizeEmployeeCode("TG-10000"), "TG-10000");
  assert.equal(normalizeEmployeeCode("email@example.com"), "");
  assert(validPin("000123"));
  for (const bad of [123456, "12345", "1234567", "１２３４５６", "123 45"])
    assert(!validPin(bad));
  assert.notEqual(
    attendanceRateKey("secret", "ip", "a"),
    attendanceRateKey("secret", "code", "a"),
  );
  assert(!attendanceRateKey("secret", "ip", "192.0.2.1").includes("192.0.2.1"));
});

test("salted scrypt and public clock handler enforce credentials, restricted output and retry semantics", async (t) => {
  const a = await hashAttendancePin("000123"),
    b = await hashAttendancePin("000123");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert(await verifyAttendancePin("000123", a.salt, a.hash));
  assert(!(await verifyAttendancePin("000124", a.salt, a.hash)));
  assert(!(await verifyAttendancePin("000123", "bad", a.hash)));
  const body = {
    court: randomUUID(),
    employee_code: "TG-0001",
    pin: "000123",
    action: "clock_in",
    idempotency_key: randomUUID(),
  };
  let calls: { name: string; args: Record<string, unknown> }[] = [];
  let mode = "ok";
  const api = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "garden_court_code_active")
        return { data: mode !== "qr", error: null };
      if (name === "garden_pin_reserve")
        return {
          data: { allowed: mode !== "limit", attempt_id: randomUUID() },
          error: null,
        };
      if (name === "garden_pin_lookup")
        return {
          data:
            mode === "unknown"
              ? null
              : {
                  employee_id: randomUUID(),
                  salt: a.salt,
                  pin_hash: a.hash,
                  version: randomUUID(),
                },
          error: null,
        };
      if (name === "garden_clock_by_pin")
        return mode === "network"
          ? { error: { code: "", message: "transport failed" } }
          : mode === "business"
            ? { error: { code: "P0001", message: "You are already timed in." } }
            : {
                data: {
                  name: "Alex",
                  action: "clock_in",
                  at: "2026-11-14T07:30:00Z",
                  secret: "must not leak",
                },
                error: null,
              };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
  const run = (payload: unknown = body, secret = "a".repeat(64)) => {
    calls = [];
    return handlePinClock(
      new Request("https://example.invalid/api/attendance/clock/", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      api,
      secret,
      "192.0.2.1",
    );
  };
  await t.test(
    "successful clock creates no session and forwards the original nonce",
    async () => {
      const response = await run();
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(await response.json()).sort(), [
        "action",
        "at",
        "name",
      ]);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(
        calls.find((c) => c.name === "garden_clock_by_pin")?.args.p_nonce,
        body.idempotency_key,
      );
      assert(
        calls.find((c) => c.name === "garden_pin_reserve")?.args.p_ip !==
          "192.0.2.1",
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
    },
  );
  await t.test(
    "wrong and nonexistent credentials have identical generic errors",
    async () => {
      const wrong = await run({ ...body, pin: "000999" });
      mode = "unknown";
      const unknown = await run();
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(await wrong.json(), await unknown.json());
      assert(!calls.some((c) => c.name === "garden_clock_by_pin"));
      assert.equal(
        calls.find((c) => c.name === "garden_pin_finish")?.args.p_success,
        false,
      );
    },
  );
  await t.test(
    "limits and invalid QR stop before hashing or credential lookup",
    async () => {
      mode = "limit";
      const limit = await run();
      assert.equal(limit.status, 429);
      assert.equal(limit.headers.get("retry-after"), "900");
      assert(!calls.some((c) => c.name === "garden_pin_lookup"));
      mode = "qr";
      assert.equal((await run()).status, 410);
      assert.equal(calls.length, 1);
      assert.equal(
        (await run({ ...body, idempotency_key: "bad" })).status,
        400,
      );
      assert.equal(calls.length, 0);
      assert.equal((await run(body, "")).status, 503);
      assert.equal(calls.length, 0);
    },
  );
  await t.test(
    "uncertain RPC failures stay retryable; known business rules return conflict",
    async () => {
      mode = "network";
      assert.equal((await run()).status, 503);
      mode = "business";
      assert.equal((await run()).status, 409);
    },
  );
});
