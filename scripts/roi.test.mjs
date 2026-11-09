import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
test("ROI capital ledger permissions and finance reconciliation", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } }),
    admin = randomUUID(),
    viewer = randomUUID(),
    employee = randomUUID(),
    hr = randomUUID(),
    outsider = randomUUID(),
    id = randomUUID();
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`,
  );
  for (const uid of [admin, viewer, employee, hr, outsider])
    await db.query("insert into auth.users values($1)", [uid]);
  const folder = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await fs.readdir(folder))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await fs.readFile(new URL(file, folder), "utf8"));
  await db.query(
    "insert into garden_profiles(id,display_name,role,finance_access,team_access) values($1,'Finance','admin',true,false),($2,'Viewer','viewer',true,false),($3,'Employee','employee',false,false),($4,'Staff manager','admin',false,true)",
    [admin, viewer, employee, hr],
  );
  const as = async (user, fn, role = "authenticated") => {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      user || "",
    ]);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub','',false)");
    }
  };
  await t.test(
    "finance admin records capital without creating income or expenses; retries update one row",
    async () => {
      for (let i = 0; i < 2; i++)
        await as(admin, () =>
          db.query(
            "insert into garden_capital(id,invested_on,owner,amount_cents) values($1,'2020-01-01','Jeremy',12345) on conflict(id) do update set amount_cents=excluded.amount_cents",
            [id],
          ),
        );
      assert.equal(
        (await db.query("select count(*)::int n from garden_capital")).rows[0]
          .n,
        1,
      );
      assert.equal(
        (await db.query("select count(*)::int n from garden_income")).rows[0].n,
        0,
      );
      assert.equal(
        (await db.query("select count(*)::int n from garden_expenses")).rows[0]
          .n,
        0,
      );
      assert.equal(
        (await db.query("select created_by from garden_capital")).rows[0]
          .created_by,
        admin,
      );
    },
  );
  await t.test("viewer can report capital but cannot change it", async () => {
    assert.equal(
      (await as(viewer, () => db.query("select garden_roi_snapshot() v")))
        .rows[0].v.capital.length,
      1,
    );
    await assert.rejects(
      as(viewer, () =>
        db.query(
          "insert into garden_capital(invested_on,owner,amount_cents) values('2020-01-01','Genesis',100)",
        ),
      ),
      (e) => e.code === "42501",
    );
    assert.equal(
      (
        await as(viewer, () =>
          db.query("update garden_capital set amount_cents=1 returning id"),
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await as(viewer, () =>
          db.query("delete from garden_capital returning id"),
        )
      ).rows.length,
      0,
    );
  });
  await t.test(
    "employees, staff-only admins, outsiders, and anonymous visitors have no ROI access",
    async () => {
      for (const user of [employee, hr, outsider]) {
        assert.equal(
          (await as(user, () => db.query("select garden_roi_snapshot() v")))
            .rows[0].v.capital.length,
          0,
        );
        assert.equal(
          (
            await as(user, () =>
              db.query(
                "select * from garden_audit where table_name='garden_capital'",
              ),
            )
          ).rows.length,
          0,
        );
        await assert.rejects(
          as(user, () =>
            db.query(
              "insert into garden_capital(invested_on,owner,amount_cents) values('2020-01-01','Genesis',1)",
            ),
          ),
          (e) => e.code === "42501",
        );
      }
      await assert.rejects(
        as("", () => db.query("select garden_roi_snapshot()"), "anon"),
        (e) => e.code === "42501",
      );
    },
  );
  await t.test(
    "invalid owners, zero amounts, future contributions, and missing dates are rejected",
    async () => {
      for (const sql of [
        "insert into garden_capital(invested_on,owner,amount_cents) values('2020-01-01','Other',1)",
        "insert into garden_capital(invested_on,owner,amount_cents) values('2020-01-01','Genesis',0)",
        "insert into garden_capital(invested_on,owner,amount_cents) values(current_date+2,'Genesis',1)",
        "insert into garden_capital(owner,amount_cents) values('Genesis',1)",
      ])
        await assert.rejects(as(admin, () => db.query(sql)));
    },
  );
  await t.test(
    "capital-purchase marks require an existing payment, a reason, and a unique link",
    async () => {
      const category = (
          await db.query(
            "select id from garden_categories where name='Equipment'",
          )
        ).rows[0].id,
        expense = randomUUID();
      await as(admin, () =>
        db.query(
          "insert into garden_expenses(id,paid_on,category_id,payment_kind,amount_cents) values($1,'2020-01-01',$2,'operating',10000)",
          [expense, category],
        ),
      );
      await as(admin, () =>
        db.query(
          "insert into garden_roi_exclusions(expense_id,reason) values($1,'Part of initial construction investment')",
          [expense],
        ),
      );
      await assert.rejects(
        as(admin, () =>
          db.query(
            "insert into garden_roi_exclusions(expense_id,reason) values($1,'Duplicate')",
            [expense],
          ),
        ),
        (e) => e.code === "23505",
      );
      await assert.rejects(
        as(admin, () =>
          db.query(
            "insert into garden_roi_exclusions(expense_id,reason) values($1,'Missing payment')",
            [randomUUID()],
          ),
        ),
        (e) => e.code === "23503",
      );
      assert.equal(
        (
          await db.query(
            "select sum(amount_cents)::int amount from garden_expenses",
          )
        ).rows[0].amount,
        10000,
      );
      assert.equal(
        (
          await as(hr, () =>
            db.query(
              "select * from garden_audit where table_name='garden_roi_exclusions'",
            ),
          )
        ).rows.length,
        0,
      );
      await as(admin, () =>
        db.query("delete from garden_expenses where id=$1", [expense]),
      );
      assert.equal(
        (await db.query("select count(*)::int n from garden_roi_exclusions"))
          .rows[0].n,
        0,
      );
    },
  );
  await t.test(
    "ROI snapshot is not truncated at the API row limit",
    async () => {
      await db.exec(
        "insert into garden_capital(invested_on,owner,amount_cents) select date '2020-01-01','Ken',1 from generate_series(1,1001)",
      );
      assert.equal(
        (await as(viewer, () => db.query("select garden_roi_snapshot() v")))
          .rows[0].v.capital.length,
        1002,
      );
    },
  );
  await t.test(
    "linked payroll payments cannot be marked as capital purchases",
    async () => {
      const e = randomUUID(),
        request = randomUUID(),
        payment = randomUUID(),
        expense = randomUUID();
      const category = (
        await db.query("select id from garden_categories where name='Wages'")
      ).rows[0].id;
      await db.query(
        "insert into garden_employees(id,name,email,started_on) values($1,'Sample employee','sample@example.invalid','2020-01-01')",
        [e],
      );
      await db.query(
        "insert into garden_staff_requests(id,employee_id,kind,amount_cents,reason,status) values($1,$2,'advance',10000,'Test','approved')",
        [request, e],
      );
      await db.query(
        "insert into garden_staff_cash(id,employee_id,kind,request_id,amount_cents,paid_on) values($1,$2,'advance',$3,10000,'2020-01-01')",
        [payment, e, request],
      );
      await db.query(
        "insert into garden_expenses(id,paid_on,category_id,payment_kind,amount_cents,staff_payment_id) values($1,'2020-01-01',$2,'operating',10000,$3)",
        [expense, category, payment],
      );
      await assert.rejects(
        as(admin, () =>
          db.query(
            "insert into garden_roi_exclusions(expense_id,reason) values($1,'Should fail')",
            [expense],
          ),
        ),
        /Payroll payments/,
      );
    },
  );
  await db.close();
});
