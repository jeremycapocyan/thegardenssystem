import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

test("Private PIN attendance and timesheet database reports", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } });
  const [owner, viewer, finance, hr, manager, user, other] = Array.from(
      { length: 7 },
      () => randomUUID(),
    ),
    eid = randomUUID(),
    otherEid = randomUUID();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for (const id of [owner, viewer, finance, hr, manager, user, other])
    await db.query("insert into auth.users values($1)", [id]);
  const folder = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await fs.readdir(folder))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(await fs.readFile(new URL(file, folder), "utf8"));
    if (file.includes("gardens_finance"))
      await db.query(
        "insert into garden_profiles(id,display_name,role) values($1,'Jeremy','admin'),($2,'Genesis','viewer')",
        [owner, viewer],
      );
  }
  const as = async (id, fn, role = "authenticated") => {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      id || "",
    ]);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub','',false)");
    }
  };
  const value = async (sql, args = []) =>
    (await db.query(sql, args)).rows[0]?.v;
  const command = (id, action, payload) =>
    as(id, () =>
      value("select garden_team_command($1,$2::jsonb) v", [
        action,
        JSON.stringify(payload),
      ]),
    );
  const service = (sql, args = []) =>
    as("", () => value(sql, args), "service_role");
  for (const [id, f, h, a] of [
    [finance, true, false, false],
    [hr, false, true, false],
    [manager, false, false, true],
  ])
    await db.query(
      "select garden_manage_account($1,$2,'Admin','admin',$3,$4,$5,true)",
      [owner, id, f, h, a],
    );
  for (const [id, uid, name] of [
    [eid, user, "María Peña"],
    [otherEid, other, "Sam Santos"],
  ]) {
    await command(owner, "employee", {
      id,
      name,
      email: `${uid}@example.invalid`,
      started_on: "2020-01-01",
      effective_from: "2020-01-01",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      active: true,
    });
    await db.query("select garden_bind_employee($1,$2)", [id, uid]);
  }
  const code = await value(
      "select employee_code v from garden_employees where id=$1",
      [eid],
    ),
    salt = "a".repeat(32),
    hash = "b".repeat(128);
  let version, qr;
  const setPin = () =>
    service("select garden_set_attendance_pin($1,$2,$3) v", [user, salt, hash]);
  await t.test(
    "codes are unique and permanent; readiness is safe while all credential functions and tables are private",
    async () => {
      assert.match(code, /^TG-\d{4}$/);
      assert.equal(
        await value(
          "select count(distinct employee_code)::int v from garden_employees",
        ),
        2,
      );
      await assert.rejects(
        db.query(
          "update garden_employees set employee_code='TG-9999' where id=$1",
          [eid],
        ),
        /permanent/,
      );
      await db.exec("select setval('garden_employee_code_seq',9999)");
      assert.equal(
        await value("select garden_next_employee_code() v"),
        "TG-10000",
      );
      for (const id of [user, owner, manager, viewer])
        await as(id, async () => {
          for (const table of ["garden_attendance_pins", "garden_pin_attempts"])
            await assert.rejects(
              db.query(`select * from ${table}`),
              (e) => e.code === "42501",
            );
          await assert.rejects(
            db.query("select garden_set_attendance_pin($1,$2,$3)", [
              user,
              salt,
              hash,
            ]),
            (e) => e.code === "42501",
          );
          await assert.rejects(
            db.query("select garden_pin_lookup($1)", [code]),
            (e) => e.code === "42501",
          );
          await assert.rejects(
            db.query("select garden_pin_reserve($1,$2)", [
              "a".repeat(64),
              "b".repeat(64),
            ]),
            (e) => e.code === "42501",
          );
        });
      await setPin();
      version = (await service("select garden_pin_lookup($1) v", [code]))
        .version;
      const snapshot = await as(user, () =>
        value("select garden_team_snapshot() v"),
      );
      assert.equal(snapshot.employees[0].employee_code, code);
      assert.equal(snapshot.employees[0].pin_configured, true);
      assert(!JSON.stringify(snapshot).includes(hash));
      assert(!JSON.stringify(snapshot).includes(salt));
      assert(
        !JSON.stringify(
          (
            await db.query(
              "select * from garden_audit where table_name='garden_pin_security'",
            )
          ).rows,
        ).includes(hash),
      );
      await as(other, () =>
        assert.rejects(
          db.query("select garden_pin_configured($1)", [eid]),
          (e) => e.code === "42501",
        ),
      );
    },
  );
  await t.test(
    "shared reservations enforce five per code and twenty per IP, expire, and release successful authentications",
    async () => {
      const ip = "c".repeat(64),
        c = "d".repeat(64),
        attempts = [];
      for (let i = 0; i < 5; i++)
        attempts.push(
          (await service("select garden_pin_reserve($1,$2) v", [ip, c]))
            .attempt_id,
        );
      assert.equal(
        (
          await service("select garden_pin_reserve($1,$2) v", [
            "e".repeat(64),
            c,
          ])
        ).allowed,
        false,
      );
      await service("select garden_pin_finish($1,true) v", [attempts[0]]);
      await service("select garden_pin_finish($1,false) v", [attempts[0]]);
      assert.equal(
        await value("select status v from garden_pin_attempts where id=$1", [
          attempts[0],
        ]),
        "success",
      );
      assert.equal(
        (await service("select garden_pin_reserve($1,$2) v", [ip, c])).allowed,
        true,
      );
      await db.exec("truncate garden_pin_attempts");
      for (let i = 0; i < 20; i++)
        assert.equal(
          (
            await service("select garden_pin_reserve($1,$2) v", [
              ip,
              i.toString(16).padStart(64, "0"),
            ])
          ).allowed,
          true,
        );
      assert.equal(
        (
          await service("select garden_pin_reserve($1,$2) v", [
            ip,
            "f".repeat(64),
          ])
        ).allowed,
        false,
      );
      await db.exec(
        "update garden_pin_attempts set created_at=now()-interval '16 minutes'",
      );
      assert.equal(
        (
          await service("select garden_pin_reserve($1,$2) v", [
            ip,
            "f".repeat(64),
          ])
        ).allowed,
        true,
      );
    },
  );
  await t.test(
    "PIN clocks preserve database timestamps, retry identity, one open session and overnight work dates",
    async () => {
      qr = (await command(owner, "qr", {})).id;
      const nonce = randomUUID(),
        punch = (action, id = nonce, v = version, court = qr) =>
          service("select garden_clock_by_pin($1,$2,$3,$4,$5) v", [
            eid,
            v,
            court,
            action,
            id,
          ]);
      await assert.rejects(
        punch("clock_in", randomUUID(), randomUUID()),
        /PIN changed/,
      );
      await assert.rejects(
        punch("clock_in", randomUUID(), version, randomUUID()),
        /no longer valid/,
      );
      const before = Date.now(),
        first = await punch("clock_in");
      assert(Math.abs(new Date(first.at).valueOf() - before) < 10000);
      assert.deepEqual(Object.keys(first).sort(), ["action", "at", "name"]);
      assert.deepEqual(await punch("clock_in"), first);
      await assert.rejects(punch("clock_in", randomUUID()), /already timed in/);
      await assert.rejects(punch("clock_out", randomUUID()), /one minute/);
      assert.equal(
        await value(
          "select source v from garden_attendance_events where id=$1",
          [nonce],
        ),
        "pin",
      );
      await db.query(
        "update garden_attendance set clock_in=now()-interval '10 hours',work_date=(now() at time zone 'Asia/Manila')::date-1 where employee_id=$1",
        [eid],
      );
      const out = randomUUID();
      await punch("clock_out", out);
      await punch("clock_out", out);
      assert.equal(
        await value(
          "select count(*)::int v from garden_attendance where employee_id=$1",
          [eid],
        ),
        1,
      );
      assert.equal(
        await value(
          "select work_date=((now() at time zone 'Asia/Manila')::date-1) v from garden_attendance where employee_id=$1",
          [eid],
        ),
        true,
      );
      await as(user, () =>
        assert.rejects(
          db.query("select garden_clock_by_pin($1,$2,$3,$4,$5)", [
            eid,
            version,
            qr,
            "clock_in",
            randomUUID(),
          ]),
          (e) => e.code === "42501",
        ),
      );
    },
  );
  await t.test(
    "PIN replacement, revocation, deactivation and QR replacement invalidate cached authorization",
    async () => {
      await setPin();
      const next = (await service("select garden_pin_lookup($1) v", [code]))
        .version;
      assert.notEqual(next, version);
      await assert.rejects(
        service("select garden_clock_by_pin($1,$2,$3,$4,$5) v", [
          eid,
          version,
          qr,
          "clock_in",
          randomUUID(),
        ]),
        /PIN changed/,
      );
      await as(user, () =>
        assert.rejects(
          db.query("select garden_revoke_attendance_pin($1)", [eid]),
          (e) => e.code === "42501",
        ),
      );
      await as(hr, () =>
        assert.rejects(
          db.query("select garden_revoke_attendance_pin($1)", [eid]),
          (e) => e.code === "42501",
        ),
      );
      await as(manager, () =>
        db.query("select garden_revoke_attendance_pin($1)", [eid]),
      );
      assert.equal(
        await service("select garden_pin_lookup($1) v", [code]),
        null,
      );
      await setPin();
      await db.query("update garden_profiles set active=false where id=$1", [
        user,
      ]);
      assert.equal(
        await service("select garden_pin_lookup($1) v", [code]),
        null,
      );
      await assert.rejects(setPin(), (e) => e.code === "42501");
      await db.query("update garden_profiles set active=true where id=$1", [
        user,
      ]);
      await command(owner, "qr", {});
      assert.equal(
        await service("select garden_court_code_active($1) v", [qr]),
        false,
      );
    },
  );
  const report = (
    id,
    start = "2020-01-01",
    end = "2020-01-02",
    employee = eid,
  ) =>
    as(id, () =>
      value("select garden_timesheet_report($1,$2,$3) v", [
        start,
        end,
        employee,
      ]),
    );
  await t.test(
    "only HR managers export; report ranges validate and retain historic inactive staff",
    async () => {
      for (const id of [user, viewer, finance, manager])
        await assert.rejects(report(id), (e) => e.code === "42501");
      await as(
        "",
        () =>
          assert.rejects(
            db.query(
              "select garden_timesheet_report('2020-01-01','2020-01-02')",
            ),
            (e) => e.code === "42501",
          ),
        "anon",
      );
      await assert.rejects(report(hr, "2020-01-01", "2020-02-01"), /31 days/);
      assert.equal(
        (await report(hr, "2020-02-01", "2020-02-29", null)).employees.length,
        2,
      );
      await db.query("update garden_employees set active=false where id=$1", [
        eid,
      ]);
      assert.equal((await report(hr)).employees.length, 1);
      await db.query("update garden_employees set active=true where id=$1", [
        eid,
      ]);
    },
  );
  await t.test(
    "live and frozen totals reconcile without double deduction; reports do not mutate payroll or expenses",
    async () => {
      const correction = (date, clock_in, clock_out) =>
        command(owner, "correct", {
          employee_id: eid,
          date,
          clock_in,
          clock_out,
          reason: "Test-only correction",
        });
      await correction(
        "2020-01-01",
        "2020-01-01T08:00:00Z",
        "2020-01-01T15:30:00Z",
      );
      await correction(
        "2020-01-02",
        "2020-01-02T07:30:00Z",
        "2020-01-02T16:30:00Z",
      );
      let r = (await report(hr)).employees[0];
      assert.equal(r.days[1].recorded_seconds, 32400);
      assert.equal(r.days[1].overtime_seconds, 3600);
      assert.equal(r.days[1].ot_cents, 0);
      await command(owner, "overtime", {
        employee_id: eid,
        attendance_id: r.days[1].attendance_id,
        seconds: 3600,
      });
      r = (await report(hr)).employees[0];
      assert.equal(r.totals.gross_cents, 134062);
      assert.equal(r.totals.deduction_cents, 4063);
      assert.equal(r.days[0].finalized, false);
      const counts = await value(
        "select jsonb_build_array((select count(*) from garden_expenses),(select count(*) from garden_payroll)) v",
      );
      const p = await command(owner, "finalize", {
        employee_id: eid,
        period_start: "2020-01-01",
      });
      await db.query(
        "update garden_attendance set clock_out='2020-01-02T15:30:00Z' where employee_id=$1 and work_date='2020-01-02'",
        [eid],
      );
      r = (await report(hr, "2020-01-02", "2020-01-02")).employees[0];
      assert.equal(r.totals.gross_cents, 73125);
      assert.equal(r.days[0].finalized, true);
      assert.equal(r.days.length, 1);
      const after = await value(
        "select jsonb_build_array((select count(*) from garden_expenses),(select count(*) from garden_payroll)) v",
      );
      assert.equal(after[0], counts[0]);
      assert.equal(after[1], counts[1] + 1);
      const future = (await report(hr, "2099-01-01", "2099-01-01"))
        .employees[0];
      assert.equal(future.days[0].status, "Upcoming");
    },
  );
  await db.close();
});
