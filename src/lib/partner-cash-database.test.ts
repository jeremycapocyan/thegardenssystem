import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
test("Partner cash advances reconcile financing, purchases and principal repayments", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } });
  const [admin, viewer, employee, hr, disabled] = Array.from(
    { length: 5 },
    () => randomUUID(),
  );
  await db.exec(
    "create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;",
  );
  for (const id of [admin, viewer, employee, hr, disabled])
    await db.query("insert into auth.users values($1)", [id]);
  for (const f of (await fs.readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await fs.readFile("supabase/migrations/" + f, "utf8"));
  await db.query(
    "insert into garden_profiles(id,display_name,role,finance_access,team_access,active)values($1,'Finance','admin',true,false,true),($2,'Viewer','viewer',true,false,true),($3,'Employee','employee',false,false,true),($4,'HR','admin',false,true,true),($5,'Disabled','admin',true,true,false)",
    [admin, viewer, employee, hr, disabled],
  );
  async function as<T>(id: string, fn: () => Promise<T>) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  const one = async (sql: string, args: unknown[] = []) =>
    (await db.query<any>(sql, args)).rows[0];
  const cmd = (
    action: string,
    payload: Record<string, unknown>,
    id = randomUUID(),
    actor = admin,
  ) =>
    as(
      actor,
      async () =>
        (
          await one("select garden_partner_cash_command($1,$2,$3) v", [
            action,
            id,
            JSON.stringify(payload),
          ])
        ).v,
    );
  await as(admin, () =>
    db.query("select garden_cash_setup('2020-01-01',0,0,0)"),
  );
  const category = (
    await one("select id from garden_categories where kind='expense' limit 1")
  ).id;
  const receive = (extra: Record<string, unknown> = {}) =>
    cmd("receive", {
      owner: "Genesis",
      purpose: "Fictional equipment advance",
      received_on: "2020-01-01",
      amount_cents: 2500000,
      monthly_cents: 2500000,
      first_due: "2020-02-29",
      account: "cash",
      ...extra,
    });
  const buy = (id: string, extra: Record<string, unknown> = {}) =>
    cmd("purchase", {
      advance_id: id,
      paid_on: "2020-01-02",
      amount_cents: 2500000,
      total_cents: 2500000,
      category_id: category,
      account: "cash",
      notes: "Fictional equipment",
      reference: "test",
      ...extra,
    });
  const repay = (id: string, extra: Record<string, unknown> = {}) =>
    cmd("repay", {
      advance_id: id,
      paid_on: "2020-02-29",
      amount_cents: 2500000,
      account: "cash",
      ...extra,
    });
  await t.test(
    "receipt is financing; purchase alone creates expense; repayment clears debt without another expense",
    async () => {
      const before = await one(
        "select (select count(*) from garden_expenses)::int expenses,(select count(*) from garden_capital)::int capital,(select count(*) from garden_income)::int income",
      );
      const a = await receive();
      let cash = await one(
        "select sum(case when to_account='cash' then amount_cents else -amount_cents end)::text n from garden_cash_movements",
      );
      assert.equal(cash.n, "2500000");
      const b = await buy(a.id);
      const r = await repay(a.id);
      assert.ok(b.id && r.id);
      const after = await one(
        "select (select count(*) from garden_expenses)::int expenses,(select count(*) from garden_capital)::int capital,(select count(*) from garden_income)::int income",
      );
      assert.equal(after.expenses, before.expenses + 1);
      assert.equal(after.capital, before.capital);
      assert.equal(after.income, before.income);
      assert.equal(
        (
          await one(
            "select sum(amount_cents)::text n from garden_partner_cash_repayments where advance_id=$1",
            [a.id],
          )
        ).n,
        "2500000",
      );
      assert.equal(
        (
          await one(
            "select (coalesce((select sum(case when to_account='cash' then amount_cents else -amount_cents end) from garden_cash_movements),0)-coalesce((select sum(amount_cents) from garden_cash_allocations where account='cash' and expense_id is not null),0))::text n",
          )
        ).n,
        "-2500000",
      );
    },
  );
  await t.test(
    "retry keys are idempotent and bound to their payload and actor",
    async () => {
      const id = randomUUID(),
        p = {
          owner: "Ken",
          purpose: "Test",
          received_on: "2020-01-03",
          amount_cents: 10000,
          monthly_cents: 5000,
          first_due: "2020-02-29",
          account: "bank",
        };
      const a = await cmd("receive", p, id);
      assert.deepEqual(await cmd("receive", p, id), a);
      await assert.rejects(
        cmd("receive", { ...p, amount_cents: 20000 }, id),
        /Retry key/,
      );
      assert.equal(
        (
          await one(
            "select count(*)::int n from garden_partner_cash_advances where id=$1",
            [id],
          )
        ).n,
        1,
      );
    },
  );
  await t.test(
    "partial and early repayments, unused-fund returns and concurrent retry protect principal",
    async () => {
      const a = await receive({ amount_cents: 10000, monthly_cents: 3000 });
      await repay(a.id, { amount_cents: 4000, paid_on: "2020-01-01" });
      await repay(a.id, { amount_cents: 6000 });
      await assert.rejects(repay(a.id, { amount_cents: 1 }), /outstanding/);
      const b = await receive({ amount_cents: 10000, monthly_cents: 3000 });
      const p = {
        advance_id: b.id,
        paid_on: "2020-01-01",
        amount_cents: 7000,
        account: "cash",
      };
      const results = await as(admin, () =>
        Promise.allSettled([
          db.query("select garden_partner_cash_command($1,$2,$3)", [
            "repay",
            randomUUID(),
            JSON.stringify(p),
          ]),
          db.query("select garden_partner_cash_command($1,$2,$3)", [
            "repay",
            randomUUID(),
            JSON.stringify(p),
          ]),
        ]),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    },
  );
  await t.test(
    "existing receipt, purchase and repayment link without reposting cash or expense",
    async () => {
      const incoming = randomUUID(),
        outgoing = randomUUID(),
        eid = randomUUID(),
        allocation = randomUUID();
      await as(admin, async () => {
        await db.query(
          "select garden_cash_move($1,'2020-03-01','funding',null,'cash',15000,'old','Existing receipt')",
          [incoming],
        );
        await db.query(
          "select garden_cash_move($1,'2020-03-03','funding','bank',null,5000,'old','Existing repayment')",
          [outgoing],
        );
        await db.query(
          "insert into garden_expenses(id,paid_on,category_id,payment_kind,amount_cents,reference,notes) values($1,'2020-03-02',$2,'operating',20000,'old','Existing purchase')",
          [eid, category],
        );
        await db.query(
          "select garden_cash_allocate($1,'expenses',$2,'cash',20000)",
          [allocation, eid],
        );
      });
      const counts = await one(
        "select (select count(*) from garden_cash_movements)::int m,(select count(*) from garden_expenses)::int e,(select count(*) from garden_cash_allocations)::int c",
      );
      const a = await receive({
        received_on: "2020-03-01",
        first_due: "2020-04-01",
        amount_cents: 15000,
        monthly_cents: 15000,
        movement_id: incoming,
      });
      await buy(a.id, {
        paid_on: "2020-03-02",
        amount_cents: 15000,
        expense_id: eid,
        allocation_id: allocation,
        expected_total_cents: 20000,
        notes: "Existing purchase",
        reference: "old",
      });
      await repay(a.id, {
        paid_on: "2020-03-03",
        amount_cents: 5000,
        account: "bank",
        movement_id: outgoing,
      });
      assert.deepEqual(
        await one(
          "select (select count(*) from garden_cash_movements)::int m,(select count(*) from garden_expenses)::int e,(select count(*) from garden_cash_allocations)::int c",
        ),
        counts,
      );
      await assert.rejects(
        receive({
          received_on: "2020-03-01",
          first_due: "2020-04-01",
          amount_cents: 15000,
          monthly_cents: 15000,
          movement_id: incoming,
        }),
        /already linked/,
      );
      await assert.rejects(
        as(admin, () =>
          db.query("delete from garden_expenses where id=$1", [eid]),
        ),
        /Partner cash advances/,
      );
      await assert.rejects(
        as(admin, () =>
          db.query("select garden_cash_unassign($1)", [allocation]),
        ),
        /Partner cash advances/,
      );
    },
  );
  await t.test(
    "purchase funding caps and stale previews fail without partial writes",
    async () => {
      const a = await receive({ amount_cents: 10000, monthly_cents: 10000 });
      await assert.rejects(
        buy(a.id, { amount_cents: 10001, total_cents: 20000 }),
        /exceed the advance/,
      );
      await buy(a.id, { amount_cents: 6000, total_cents: 10000 });
      await assert.rejects(
        buy(a.id, { amount_cents: 5000, total_cents: 10000 }),
        /exceed the advance/,
      );
      const s = await one(
        "select * from garden_partner_cash_spends where advance_id=$1",
        [a.id],
      );
      const b = await receive({ amount_cents: 10000, monthly_cents: 10000 });
      await assert.rejects(
        buy(b.id, {
          amount_cents: 5000,
          expense_id: s.expense_id,
          expected_total_cents: 9999,
          notes: "Fictional equipment",
          reference: "test",
        }),
        /changed/,
      );
      await assert.rejects(
        buy(b.id, {
          amount_cents: 5000,
          expense_id: s.expense_id,
          allocation_id: s.allocation_id,
          expected_total_cents: 10000,
          notes: "Fictional equipment",
          reference: "test",
        }),
        /Funding links/,
      );
    },
  );
  await t.test(
    "corrections require reasons, protect dependencies, and keep audit history",
    async () => {
      const a = await receive({ amount_cents: 10000, monthly_cents: 10000 });
      const s = await buy(a.id, { amount_cents: 10000, total_cents: 10000 });
      const r = await repay(a.id, { amount_cents: 5000 });
      await assert.rejects(
        cmd("void_receipt", { record_id: a.id, reason: "Mistake" }),
        /linked purchases/,
      );
      await assert.rejects(
        cmd("void_repayment", { record_id: r.id, reason: "" }),
        /reason/,
      );
      await cmd("void_repayment", {
        record_id: r.id,
        reason: "Incorrect amount",
      });
      await cmd("void_purchase", {
        record_id: s.id,
        reason: "Incorrect purchase",
      });
      await cmd("void_receipt", {
        record_id: a.id,
        reason: "Incorrect receipt",
      });
      assert.ok(
        (
          await one(
            "select voided_at,detail from garden_partner_cash_advances where id=$1",
            [a.id],
          )
        ).voided_at,
      );
      assert.equal(
        (
          await one(
            "select count(*)::int n from garden_partner_cash_spends where id=$1",
            [s.id],
          )
        ).n,
        1,
      );
      assert.equal(
        (
          await one(
            "select count(*)::int n from garden_expenses where id=(select (detail->'expense'->>'id')::uuid from garden_partner_cash_spends where id=$1)",
            [s.id],
          )
        ).n,
        0,
      );
    },
  );
  await t.test(
    "role boundaries and snapshots retain finance-only data",
    async () => {
      for (const actor of [viewer, employee, hr, disabled])
        await assert.rejects(
          cmd("receive", {}, randomUUID(), actor),
          /Finance management/,
        );
      const snap = await as(viewer, () => one("select garden_snapshot() v"));
      assert.ok(Array.isArray(snap.v.partner_cash.advances));
      for (const actor of [employee, hr, disabled]) {
        await assert.rejects(
          as(actor, () => one("select garden_partner_cash_snapshot() v")),
          /Finance viewing/,
        );
        assert.equal(
          (
            await as(actor, () =>
              one("select count(*)::int n from garden_partner_cash_advances"),
            )
          ).n,
          0,
        );
        assert.equal(
          (
            await as(actor, () =>
              one(
                "select count(*)::int n from garden_audit where table_name like 'garden_partner_cash_%'",
              ),
            )
          ).n,
          0,
        );
      }
      await db.exec("set role anon");
      await assert.rejects(
        db.query("select garden_partner_cash_snapshot()"),
        /permission denied/,
      );
      await db.exec("reset role");
    },
  );
  await db.close();
});
