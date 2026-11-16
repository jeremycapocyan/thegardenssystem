import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
test("cash balances database permissions, allocations and idempotent transfers", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } }),
    admin = randomUUID(),
    viewer = randomUUID(),
    employee = randomUUID(),
    hr = randomUUID();
  await db.exec(
    "create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;",
  );
  for (const id of [admin, viewer, employee, hr])
    await db.query("insert into auth.users values($1)", [id]);
  for (const file of (await fs.readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await fs.readFile("supabase/migrations/" + file, "utf8"));
  await db.query(
    "insert into garden_profiles(id,display_name,role,finance_access,team_access) values($1,'Finance','admin',true,false),($2,'Viewer','viewer',true,false),($3,'Employee','employee',false,false),($4,'HR','admin',false,true)",
    [admin, viewer, employee, hr],
  );
  async function as(uid, fn, role = "authenticated") {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      uid || "",
    ]);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  const categories = (await db.query("select * from garden_categories")).rows,
    inc = categories.find((c) => c.kind === "income").id,
    exp = categories.find((c) => c.kind === "expense").id,
    income = randomUUID(),
    expense = randomUUID(),
    payout = randomUUID();
  await as(admin, async () => {
    await db.query(
      "insert into garden_income(id,business_date,category_id,amount_cents)values($1,'2020-01-02',$2,100000)",
      [income, inc],
    );
    await db.query(
      "insert into garden_expenses(id,paid_on,category_id,payment_kind,amount_cents)values($1,'2020-01-02',$2,'operating',10000)",
      [expense, exp],
    );
    await db.query(
      "insert into garden_payouts(id,paid_on,owner,settlement_month,amount_cents)values($1,'2020-01-03','Jeremy','2020-01-01',20000)",
      [payout],
    );
  });
  await t.test(
    "opening balances are explicit, immutable, audited and finance-admin only",
    async () => {
      for (const id of [viewer, employee, hr])
        await assert.rejects(
          as(id, () =>
            db.query(
              "select garden_cash_setup('2020-01-01',10000,20000,30000)",
            ),
          ),
          (e) => e.code === "42501",
        );
      await as(admin, () =>
        db.query("select garden_cash_setup('2020-01-01',10000,20000,30000)"),
      );
      await assert.rejects(
        as(admin, () =>
          db.query("select garden_cash_setup('2020-01-01',0,0,0)"),
        ),
        (e) => e.code === "23505",
      );
      await assert.rejects(
        as(admin, () => db.query("update garden_cash_settings set cash=0")),
        (e) => e.code === "42501",
      );
      assert.equal(
        (
          await db.query(
            "select count(*)::int n from garden_audit where table_name='garden_cash_settings'",
          )
        ).rows[0].n,
        1,
      );
    },
  );
  const a = randomUUID(),
    b = randomUUID();
  await t.test(
    "split receipt assignments cap at the parent total and protect edits",
    async () => {
      await as(admin, async () => {
        for (let n = 0; n < 2; n++)
          await db.query(
            "select garden_cash_allocate($1,'income',$2,'cash',60000)",
            [a, income],
          );
        await db.query(
          "select garden_cash_allocate($1,'income',$2,'booking',40000)",
          [b, income],
        );
        await assert.rejects(
          db.query("select garden_cash_allocate($1,'income',$2,'bank',1)", [
            randomUUID(),
            income,
          ]),
          /cannot exceed/,
        );
        await assert.rejects(
          db.query("update garden_income set amount_cents=99999 where id=$1", [
            income,
          ]),
          /account assignments/,
        );
        await assert.rejects(
          db.query(
            "update garden_income set business_date='2019-12-31' where id=$1",
            [income],
          ),
          /tracked dates/,
        );
        await assert.rejects(
          db.query(
            "select garden_cash_allocate($1,'expenses',$2,'cash',1000)",
            [a, expense],
          ),
          /another entry/,
        );
        await db.query(
          "select garden_cash_allocate($1,'expenses',$2,'booking',10000)",
          [randomUUID(), expense],
        );
        await db.query(
          "select garden_cash_allocate($1,'payouts',$2,'bank',20000)",
          [randomUUID(), payout],
        );
      });
      assert.equal(
        (await db.query("select count(*)::int n from garden_cash_allocations"))
          .rows[0].n,
        4,
      );
    },
  );
  const transfer = randomUUID();
  await t.test(
    "booking withdrawal transfers once and leaves profit and expense records intact",
    async () => {
      const before = (await db.query("select garden_snapshot() v")).rows[0].v;
      await as(admin, async () => {
        for (let n = 0; n < 2; n++)
          await db.query(
            "select garden_cash_move($1,'2020-01-04','transfer','booking','bank',30000,'WITHDRAW-1','Booking withdrawal')",
            [transfer],
          );
        await assert.rejects(
          db.query(
            "select garden_cash_move($1,'2020-01-04','transfer','booking','bank',29999,'WITHDRAW-1','Booking withdrawal')",
            [transfer],
          ),
          /Retry key/,
        );
        await assert.rejects(
          db.query(
            "select garden_cash_move($1,'2020-01-04','transfer','cash','cash',1,'','Invalid transfer')",
            [randomUUID()],
          ),
          (e) => e.code === "23514",
        );
        await assert.rejects(
          db.query(
            "select garden_cash_move($1,'2019-12-31','funding',null,'cash',1,'','Too early')",
            [randomUUID()],
          ),
          /opening date/,
        );
        await db.query(
          "select garden_cash_move($1,'2020-01-05','adjustment','cash',null,100,'COUNT-1','Cash count correction')",
          [randomUUID()],
        );
      });
      const after = (await db.query("select garden_snapshot() v")).rows[0].v;
      for (const key of ["income", "expenses", "payouts"])
        assert.deepEqual(after[key], before[key]);
      assert.equal(
        (await db.query("select count(*)::int n from garden_cash_movements"))
          .rows[0].n,
        2,
      );
    },
  );
  await t.test(
    "viewers read; employee, HR-only, disabled, and anonymous accounts cannot reach balances",
    async () => {
      const s = (
        await as(viewer, () => db.query("select garden_balances_snapshot() v"))
      ).rows[0].v;
      assert.equal(s.allocations.length, 4);
      assert.equal(s.movements.length, 2);
      const report = (
        await as(viewer, () =>
          db.query("select garden_finance_report_snapshot() v"),
        )
      ).rows[0].v;
      assert.equal(report.balances.settings.bank, 20000);
      for (const id of [employee, hr]) {
        await assert.rejects(
          as(id, () => db.query("select garden_balances_snapshot()")),
          (e) => e.code === "42501",
        );
        assert.equal(
          (
            await as(id, () =>
              db.query("select * from garden_cash_allocations"),
            )
          ).rows.length,
          0,
        );
      }
      await assert.rejects(
        as(null, () => db.query("select garden_balances_snapshot()"), "anon"),
        (e) => e.code === "42501",
      );
      for (const id of [viewer, employee, hr])
        await assert.rejects(
          as(id, () =>
            db.query(
              "select garden_cash_move($1,'2020-01-04','transfer','cash','bank',1,'','Attempt')",
              [randomUUID()],
            ),
          ),
          (e) => e.code === "42501",
        );
      await db.query("update garden_profiles set active=false where id=$1", [
        admin,
      ]);
      await assert.rejects(
        as(admin, () => db.query("select garden_cash_unassign($1)", [a])),
        (e) => e.code === "42501",
      );
      await db.query("update garden_profiles set active=true where id=$1", [
        admin,
      ]);
    },
  );
  await t.test(
    "removing or deleting a finance entry releases its assignments",
    async () => {
      await as(admin, async () => {
        await db.query("select garden_cash_unassign($1)", [a]);
        await db.query(
          "update garden_income set amount_cents=40000 where id=$1",
          [income],
        );
        await db.query("delete from garden_income where id=$1", [income]);
      });
      assert.equal(
        (
          await db.query(
            "select * from garden_cash_allocations where income_id=$1",
            [income],
          )
        ).rows.length,
        0,
      );
    },
  );
  await db.close();
});
