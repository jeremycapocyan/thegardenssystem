import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

test("Employee payroll database and permissions", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } });
  const admin = randomUUID(),
    viewer = randomUUID(),
    u1 = randomUUID(),
    u2 = randomUUID(),
    u3 = randomUUID(),
    outsider = randomUUID();
  const e1 = randomUUID(),
    e2 = randomUUID(),
    e3 = randomUUID();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for (const id of [admin, viewer, u1, u2, u3, outsider])
    await db.query("insert into auth.users values($1)", [id]);
  const folder = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await fs.readdir(folder))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await fs.readFile(new URL(file, folder), "utf8"));
  await db.query(
    "insert into garden_profiles(id,display_name,role) values($1,'Jeremy','admin'),($2,'Genesis','viewer')",
    [admin, viewer],
  );
  async function as(id, fn, role = "authenticated") {
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
  }
  async function command(user, action, payload) {
    return as(
      user,
      async () =>
        (
          await db.query(
            "select public.garden_team_command($1,$2::jsonb) as value",
            [action, JSON.stringify(payload)],
          )
        ).rows[0].value,
    );
  }
  const preview = () =>
    as(
      admin,
      async () =>
        (
          await db.query(
            "select garden_payroll_preview($1,'2020-01-01') as v",
            [e1],
          )
        ).rows[0].v,
    );
  const employee = (id, name) => ({
    id,
    name,
    email: `${name.toLowerCase()}@example.invalid`,
    started_on: "2020-01-01",
    effective_from: "2020-01-01",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    active: true,
  });
  await t.test(
    "admin registers employees; invitations cannot promote owner accounts",
    async () => {
      for (const [eid, uid, name] of [
        [e1, u1, "Alex"],
        [e2, u2, "Sam"],
        [e3, u3, "Pat"],
      ]) {
        await command(admin, "employee", employee(eid, name));
        await db.query("select garden_bind_employee($1,$2)", [eid, uid]);
      }
      await assert.rejects(
        db.query("select garden_bind_employee($1,$2)", [e2, viewer]),
        /owner or administrator/,
      );
      await as(u1, () =>
        assert.rejects(
          db.query("select garden_bind_employee($1,$2)", [e1, u2]),
          (e) => e.code === "42501",
        ),
      );
    },
  );
  await t.test(
    "employees see only own HR records and no owner finance records",
    async () => {
      await as(u1, async () => {
        assert.equal(
          (await db.query("select * from garden_employees")).rows.length,
          1,
        );
        assert.equal(
          (await db.query("select * from garden_employees where id=$1", [e2]))
            .rows.length,
          0,
        );
        assert.equal(
          (await db.query("select garden_is_member() as v")).rows[0].v,
          false,
        );
        const data = (await db.query("select garden_snapshot() as v")).rows[0]
          .v;
        assert.deepEqual(data.income, []);
        assert.deepEqual(data.categories, []);
        await assert.rejects(
          db.query("update garden_employees set name='Forged' where id=$1", [
            e1,
          ]),
          (e) => e.code === "42501",
        );
      });
      await as(viewer, async () => {
        assert.equal(
          (await db.query("select * from garden_employees")).rows.length,
          0,
        );
        assert.equal(
          (await db.query("select garden_team_snapshot() as v")).rows[0].v
            .employees.length,
          0,
        );
      });
      await as(outsider, async () =>
        assert.equal(
          (await db.query("select * from garden_employees")).rows.length,
          0,
        ),
      );
      await as(
        "",
        () =>
          assert.rejects(
            db.query("select garden_team_snapshot()"),
            (e) => e.code === "42501",
          ),
        "anon",
      );
    },
  );
  let qr,
    nonce = randomUUID();
  await t.test(
    "QR time-in is server stamped, identity-bound and idempotent",
    async () => {
      qr = (await command(admin, "qr", {})).id;
      await assert.rejects(
        command(u3, "clock_in", { id: randomUUID(), qr: randomUUID() }),
        /no longer valid/,
      );
      const before = Date.now();
      await command(u3, "clock_in", {
        id: nonce,
        qr,
        employee_id: e1,
        clock_in: "2000-01-01T00:00:00Z",
      });
      await command(u3, "clock_in", { id: nonce, qr });
      const rows = (
        await db.query("select * from garden_attendance where employee_id=$1", [
          e3,
        ])
      ).rows;
      assert.equal(rows.length, 1);
      assert(Math.abs(new Date(rows[0].clock_in).valueOf() - before) < 10000);
      await assert.rejects(
        command(u3, "clock_in", { id: randomUUID(), qr }),
        /already timed in/,
      );
      await assert.rejects(
        command(u3, "clock_out", { id: randomUUID(), qr }),
        /one minute/,
      );
      await db.query(
        "update garden_attendance set clock_in=now()-interval '61 seconds' where employee_id=$1",
        [e3],
      );
      await command(u3, "clock_out", { id: randomUUID(), qr });
      qr = (await command(admin, "qr", {})).id;
      await assert.rejects(
        command(u2, "clock_in", { id: randomUUID(), qr: rows[0].id }),
        /no longer valid/,
      );
    },
  );
  const correct = (date, clock_in, clock_out) =>
    command(admin, "correct", {
      employee_id: e1,
      date,
      clock_in,
      clock_out,
      reason: "Test fixture correction",
    });
  await t.test(
    "salary uses missed-time deductions, approved overnight overtime and exact centavos",
    async () => {
      await correct(
        "2020-01-01",
        "2020-01-01T08:00:00Z",
        "2020-01-01T15:30:00Z",
      );
      await correct(
        "2020-01-02",
        "2020-01-02T07:30:00Z",
        "2020-01-02T16:30:00Z",
      );
      let p = await preview();
      assert.equal(p.days[0].regular_cents, 60937);
      assert.equal(p.days[1].regular_cents, 65000);
      assert.equal(p.days[1].overtime_seconds, 3600);
      assert(p.blockers.some((b) => b.includes("overtime")));
      await assert.rejects(
        command(admin, "finalize", {
          employee_id: e1,
          period_start: "2020-01-01",
        }),
        /Resolve all/,
      );
      await command(admin, "overtime", {
        employee_id: e1,
        attendance_id: p.days[1].attendance_id,
        seconds: 3600,
      });
      p = await preview();
      assert.equal(p.days[1].total_cents, 73125);
      assert.equal(p.gross_cents, 134062);
      await assert.rejects(
        command(u1, "overtime", {
          employee_id: e1,
          attendance_id: p.days[1].attendance_id,
          seconds: 3600,
        }),
        (e) => e.code === "42501",
      );
    },
  );
  let leave = randomUUID();
  await t.test(
    "incomplete request payloads and forged direct writes are rejected",
    async () => {
      await assert.rejects(
        command(u1, "request", {
          id: randomUUID(),
          kind: "advance",
          reason: "No amount",
        }),
        (e) => e.code === "23514",
      );
      await assert.rejects(
        command(u1, "request", {
          id: randomUUID(),
          kind: "leave",
          start_date: "2020-01-03",
          reason: "No end date",
        }),
        (e) => e.code === "23514",
      );
      await as(u1, () =>
        assert.rejects(
          db.query(
            "insert into garden_staff_requests(employee_id,kind,amount_cents,reason) values($1,'advance',100,'Forged')",
            [e2],
          ),
          (e) => e.code === "42501",
        ),
      );
    },
  );
  await t.test(
    "leave approval, overlapping requests, conflicts, void corrections and rest days",
    async () => {
      await command(u1, "request", {
        id: leave,
        kind: "sick",
        start_date: "2020-01-03",
        end_date: "2020-01-03",
        reason: "Feeling ill",
      });
      assert(
        (await preview()).blockers.some((b) => b.includes("pending leave")),
      );
      await command(admin, "decide", {
        request_id: leave,
        status: "approved",
        paid_leave: true,
        note: "Approved paid sick day",
      });
      let other = randomUUID();
      await command(u1, "request", {
        id: other,
        kind: "leave",
        start_date: "2020-01-03",
        end_date: "2020-01-03",
        reason: "Overlap",
      });
      await assert.rejects(
        command(admin, "decide", {
          request_id: other,
          status: "approved",
          paid_leave: true,
        }),
        /cannot overlap/,
      );
      await command(u1, "withdraw", { request_id: other });
      await correct(
        "2020-01-03",
        "2020-01-03T07:30:00Z",
        "2020-01-03T08:30:00Z",
      );
      let p = await preview();
      assert(p.blockers.some((b) => b.includes("overlaps attendance")));
      await command(admin, "void", {
        employee_id: e1,
        attendance_id: p.days[2].attendance_id,
        reason: "Accidental attendance on sick day",
      });
      await command(admin, "override", {
        employee_id: e1,
        date: "2020-01-04",
        working: false,
        reason: "Rest day",
      });
      p = await preview();
      assert.equal(p.days[2].leave_cents, 65000);
      assert.equal(p.days[3].status, "Rest day");
      assert.equal(p.gross_cents, 199062);
      assert.equal(p.blockers.length, 0);
      const unpaid = randomUUID();
      await command(u1, "request", {
        id: unpaid,
        kind: "leave",
        start_date: "2020-01-05",
        end_date: "2020-01-05",
        reason: "Personal leave",
      });
      await command(admin, "decide", {
        request_id: unpaid,
        status: "approved",
        paid_leave: false,
      });
      assert.equal((await preview()).days[4].total_cents, 0);
    },
  );
  const advance = randomUUID();
  const cash1 = randomUUID(),
    cash2 = randomUUID();
  let firstPayroll;
  await t.test(
    "early arrival earns no extra pay; undertime, leap dates, missing punches, and unscheduled work need correct treatment",
    async () => {
      const eid = randomUUID(),
        uid = randomUUID();
      await db.query("insert into auth.users values($1)", [uid]);
      await command(admin, "employee", employee(eid, "Taylor"));
      await db.query("select garden_bind_employee($1,$2)", [eid, uid]);
      await command(admin, "correct", {
        employee_id: eid,
        date: "2020-02-01",
        clock_in: "2020-02-01T06:30:00Z",
        clock_out: "2020-02-01T14:30:00Z",
        reason: "Undertime fixture",
      });
      const p = await as(
        admin,
        async () =>
          (
            await db.query(
              "select garden_payroll_preview($1,'2020-02-01') as v",
              [eid],
            )
          ).rows[0].v,
      );
      assert.equal(p.days[0].regular_cents, 56875);
      assert.equal(p.days[0].overtime_seconds, 0);
      assert.equal(p.days[0].undertime_seconds, 3600);
      const leap = await as(
        admin,
        async () =>
          (
            await db.query(
              "select garden_payroll_preview($1,'2020-02-16') as v",
              [eid],
            )
          ).rows[0].v,
      );
      assert.equal(leap.period_end, "2020-02-29");
      await command(admin, "correct", {
        employee_id: eid,
        date: "2020-02-02",
        clock_in: "2020-02-02T07:30:00Z",
        clock_out: null,
        reason: "Missing time out fixture",
      });
      await assert.rejects(
        command(admin, "finalize", {
          employee_id: eid,
          period_start: "2020-02-01",
        }),
        /Resolve all/,
      );
      await command(admin, "override", {
        employee_id: eid,
        date: "2020-02-01",
        working: false,
        reason: "Rest day fixture",
      });
      const conflict = await as(
        admin,
        async () =>
          (
            await db.query(
              "select garden_payroll_preview($1,'2020-02-01') as v",
              [eid],
            )
          ).rows[0].v,
      );
      assert.equal(conflict.days[0].status, "Unscheduled work");
      assert.equal(conflict.days[0].total_cents, 0);
      await command(admin, "settings", {
        category_id: (
          await db.query("select id from garden_categories where name='Wages'")
        ).rows[0].id,
      });
    },
  );
  await t.test(
    "only actual advance releases create expenses; repeated payment requests create one entry",
    async () => {
      await command(u1, "request", {
        id: advance,
        kind: "advance",
        amount_cents: 250000,
        reason: "Requested advance",
      });
      await command(admin, "decide", {
        request_id: advance,
        status: "approved",
      });
      assert.equal(
        (await db.query("select count(*) from garden_expenses")).rows[0].count,
        0,
      );
      for (const [id, amount] of [
        [cash1, 100000],
        [cash2, 150000],
      ]) {
        const p = {
          id,
          request_id: advance,
          amount_cents: amount,
          paid_on: "2020-01-01",
          reference: "Test release",
        };
        await command(admin, "release", p);
        await command(admin, "release", p);
      }
      assert.equal(
        (await db.query("select count(*) from garden_expenses")).rows[0].count,
        2,
      );
      await assert.rejects(
        command(admin, "release", {
          id: randomUUID(),
          request_id: advance,
          amount_cents: 1,
          paid_on: "2020-01-01",
        }),
        /cannot exceed/,
      );
      await as(admin, async () => {
        await assert.rejects(
          db.query(
            "update garden_expenses set amount_cents=1 where staff_payment_id=$1",
            [cash1],
          ),
          /cannot be edited/,
        );
        await assert.rejects(
          db.query("delete from garden_expenses where staff_payment_id=$1", [
            cash1,
          ]),
          /cannot be edited/,
        );
      });
    },
  );
  await t.test(
    "finalizing payroll recovers advances once, carries the remainder, and freezes the statement",
    async () => {
      firstPayroll = await command(admin, "finalize", {
        employee_id: e1,
        period_start: "2020-01-01",
      });
      assert.equal(firstPayroll.gross_cents, 199062);
      assert.equal(firstPayroll.recovery_cents, 199062);
      assert.equal(firstPayroll.payable_cents, 0);
      await command(admin, "finalize", {
        employee_id: e1,
        period_start: "2020-01-01",
      });
      assert.equal(
        (await db.query("select count(*) from garden_payroll")).rows[0].count,
        1,
      );
      const allocations = (
        await db.query(
          "select cash_id,amount_cents from garden_advance_recoveries order by amount_cents desc",
        )
      ).rows;
      assert.equal(allocations.length, 2);
      assert.equal(
        allocations.find((a) => a.cash_id === cash1).amount_cents,
        100000,
      );
      await assert.rejects(
        correct("2020-01-01", "2020-01-01T07:30:00Z", "2020-01-01T15:30:00Z"),
        /locked/,
      );
      await assert.rejects(
        command(u1, "request", {
          id: randomUUID(),
          kind: "leave",
          start_date: "2020-01-01",
          end_date: "2020-01-01",
          reason: "Late leave",
        }),
        /finalized/,
      );
    },
  );
  await t.test(
    "partial salary payments reconcile with cash expenses and cannot overpay",
    async () => {
      await correct(
        "2020-01-16",
        "2020-01-16T07:30:00Z",
        "2020-01-16T15:30:00Z",
      );
      const payroll = await command(admin, "finalize", {
        employee_id: e1,
        period_start: "2020-01-16",
      });
      assert.equal(payroll.gross_cents, 65000);
      assert.equal(payroll.recovery_cents, 50938);
      assert.equal(payroll.payable_cents, 14062);
      for (const amount of [5000, 9062]) {
        const p = {
          id: randomUUID(),
          payroll_id: payroll.id,
          amount_cents: amount,
          paid_on: "2020-02-01",
        };
        await command(admin, "pay", p);
        await command(admin, "pay", p);
      }
      await assert.rejects(
        command(admin, "pay", {
          id: randomUUID(),
          payroll_id: payroll.id,
          amount_cents: 1,
          paid_on: "2020-02-01",
        }),
        /cannot exceed/,
      );
      assert.equal(
        Number(
          (
            await db.query(
              "select sum(amount_cents) as total from garden_expenses",
            )
          ).rows[0].total,
        ),
        264062,
      );
      await as(u2, async () => {
        assert.equal(
          (await db.query("select * from garden_payroll")).rows.length,
          0,
        );
        await assert.rejects(
          db.query("select garden_payroll_preview($1,$2)", [e1, "2020-01-01"]),
          (e) => e.code === "42501",
        );
      });
    },
  );
  await t.test(
    "deactivation blocks employee mutations but retains own history; audit is private",
    async () => {
      await command(admin, "employee", {
        ...employee(e1, "Alex"),
        employee_id: e1,
        effective_from: "2020-02-01",
        active: false,
        ended_on: "2020-01-31",
      });
      await assert.rejects(
        command(u1, "request", {
          id: randomUUID(),
          kind: "advance",
          amount_cents: 100,
          reason: "Blocked",
        }),
        /inactive/,
      );
      await as(u1, async () => {
        assert.equal(
          (await db.query("select * from garden_payroll")).rows.length,
          2,
        );
        assert.equal(
          (await db.query("select * from garden_audit")).rows.length,
          0,
        );
        await assert.rejects(
          db.query("update garden_profiles set role='admin' where id=$1", [u1]),
          (e) => e.code === "42501",
        );
      });
      assert(
        (
          await db.query(
            "select count(*) from garden_audit where table_name='garden_attendance'",
          )
        ).rows[0].count > 0,
      );
    },
  );
  await db.close();
});
