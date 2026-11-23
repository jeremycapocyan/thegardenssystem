import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import type { PartnerPreview } from "./partners";
test("Partner advances transact with expenses, balances and immutable owner recovery", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } }),
    admin = randomUUID(),
    viewer = randomUUID(),
    employee = randomUUID(),
    hr = randomUUID(),
    accounts = randomUUID();
  await db.exec(
    "create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;",
  );
  for (const id of [admin, viewer, employee, hr, accounts])
    await db.query("insert into auth.users values($1)", [id]);
  for (const f of (await fs.readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await fs.readFile("supabase/migrations/" + f, "utf8"));
  await db.query(
    "insert into garden_profiles(id,display_name,role,finance_access,team_access,manage_accounts) values($1,'Finance','admin',true,false,false),($2,'Viewer','viewer',true,false,false),($3,'Employee','employee',false,false,false),($4,'HR','admin',false,true,false),($5,'Accounts','admin',false,false,true)",
    [admin, viewer, employee, hr, accounts],
  );
  async function as<T>(uid: string, fn: () => Promise<T>) {
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      uid,
    ]);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  const cmd = (
    action: string,
    payload: Record<string, unknown>,
    id = randomUUID(),
  ) =>
    as(
      admin,
      async () =>
        (
          await db.query<{ v: Record<string, unknown> }>(
            "select garden_partner_command($1,$2,$3) v",
            [action, id, JSON.stringify(payload)],
          )
        ).rows[0].v,
    );
  const preview = (month = "2020-10-01") =>
    as(
      admin,
      async () =>
        (
          await db.query<{ v: PartnerPreview }>(
            "select garden_partner_preview($1) v",
            [month],
          )
        ).rows[0].v,
    );
  const one = (sql: string, args: unknown[] = []) =>
    db.query<Record<string, unknown>>(sql, args).then((r) => r.rows[0]);
  const cat = (
    await one("select id from garden_categories where kind='expense' limit 1")
  ).id as string;
  const incomeCat = (
    await one("select id from garden_categories where kind='income' limit 1")
  ).id as string;
  const legacy = randomUUID();
  await as(admin, () =>
    db.query(
      "insert into garden_installments(id,code,name,category_id,total_cents,monthly_cents,first_due) values($1,'LEGACY','Genesis Loan',$2,20545796,1712150,'2020-10-30')",
      [legacy, cat],
    ),
  );
  await as(admin, () =>
    db.query("select garden_cash_setup('2020-01-01',20000000,0,0)"),
  );
  const purchase = randomUUID(),
    funding = randomUUID();
  await t.test(
    "finance-only write permissions and viewer-only reading",
    async () => {
      for (const uid of [viewer, employee, hr, accounts]) {
        await assert.rejects(
          as(uid, () =>
            db.query("select garden_partner_command($1,$2,$3)", [
              "rule",
              randomUUID(),
              "{}",
            ]),
          ),
          /Finance management/,
        );
        await assert.rejects(
          as(uid, () =>
            db.query("select garden_partner_preview('2020-10-01')"),
          ),
          /Finance management/,
        );
      }
      for (const uid of [employee, hr, accounts])
        await assert.rejects(
          as(uid, () => db.query("select garden_partner_snapshot()")),
          /Finance viewing/,
        );
      assert.equal(
        (
          await as(viewer, () =>
            db.query("select * from garden_partner_fundings"),
          )
        ).rows.length,
        0,
      );
    },
  );
  await t.test(
    "recording a partner purchase creates no initial expense or cash movement; retries keep IDs",
    async () => {
      const payload = {
        owner: "Genesis",
        purchased_on: "2020-10-01",
        name: "Linix Sweeper",
        category_id: cat,
        total_cents: 2500000,
        monthly_cents: 500000,
        first_due: "2020-10-30",
      };
      assert.equal(
        (await cmd("purchase", payload, purchase)).installment_id,
        purchase,
      );
      await cmd("purchase", payload, purchase);
      assert.equal(
        (await one("select count(*)::int n from garden_expenses")).n,
        0,
      );
      assert.equal(
        (await one("select count(*)::int n from garden_cash_movements")).n,
        0,
      );
      await assert.rejects(
        as(admin, () =>
          db.query("update garden_installments set total_cents=1 where id=$1", [
            purchase,
          ]),
        ),
        /Partner advances/,
      );
    },
  );
  const payment = randomUUID();
  await t.test(
    "one reimbursement produces one expense and one account assignment; partial/final and correction guards",
    async () => {
      const payload = {
        installment_id: purchase,
        paid_on: "2020-10-15",
        due_month: "2020-10-01",
        amount_cents: 500000,
        account: "cash",
        reference: "Fictional sweep installment",
      };
      await cmd("reimburse", payload, payment);
      await cmd("reimburse", payload, payment);
      assert.equal(
        (await one("select count(*)::int n from garden_expenses")).n,
        1,
      );
      assert.equal(
        (await one("select count(*)::int n from garden_cash_allocations")).n,
        1,
      );
      const e = await one(
        "select expense_id,allocation_id from garden_partner_payments where id=$1",
        [payment],
      );
      await assert.rejects(
        as(admin, () =>
          db.query("delete from garden_expenses where id=$1", [e.expense_id]),
        ),
        /Partner advances/,
      );
      await assert.rejects(
        as(admin, () =>
          db.query("select garden_cash_unassign($1)", [e.allocation_id]),
        ),
        /Partner advances/,
      );
      await assert.rejects(
        cmd("reimburse", { ...payload, amount_cents: 2500000 }),
        /outstanding obligation/,
      );
      await assert.rejects(
        as(admin, () =>
          db.query(
            "insert into garden_expenses(paid_on,category_id,payment_kind,installment_id,due_month,amount_cents) values('2020-10-15',$1,'installment',$2,'2020-10-01',1)",
            [cat, purchase],
          ),
        ),
        /Partner advances/,
      );
    },
  );
  await t.test(
    "capital funding splits exactly, affects cash once and never creates profit expense or ROI capital",
    async () => {
      const draft = {
        supplier: "Fictional supplier",
        purpose: "Capital purchase for partners",
        total_cents: 11200000,
        start_month: "2020-10-01",
        partners: [
          { owner: "Genesis", amount_cents: 5600000, rate_bps: 5000 },
          { owner: "Ken", amount_cents: 5600000, rate_bps: 5000 },
        ],
      };
      await assert.rejects(
        cmd("funding_draft", { ...draft, total_cents: 11200001 }),
        /must equal/,
      );
      await cmd("funding_draft", draft, funding);
      assert.equal(
        (await one("select count(*)::int n from garden_cash_movements")).n,
        0,
      );
      const release = randomUUID();
      await cmd(
        "fund",
        {
          funding_id: funding,
          paid_on: "2020-10-20",
          account: "cash",
          reference: "Fictional supplier payment",
        },
        release,
      );
      await cmd(
        "fund",
        {
          funding_id: funding,
          paid_on: "2020-10-20",
          account: "cash",
          reference: "Fictional supplier payment",
        },
        release,
      );
      assert.equal(
        (await one("select count(*)::int n from garden_expenses")).n,
        1,
      );
      assert.equal(
        (await one("select count(*)::int n from garden_cash_movements")).n,
        1,
      );
      assert.equal(
        (
          await one(
            "select sum(amount_cents)::text n from garden_partner_debts",
          )
        ).n,
        "11200000",
      );
      assert.equal(
        (await one("select count(*)::int n from garden_capital")).n,
        0,
      );
      await assert.rejects(
        as(admin, () =>
          db.query(
            "select garden_cash_move($1,'2020-10-20','partner_capital','cash',null,1,'x','Forgery test')",
            [randomUUID()],
          ),
        ),
        /Partner advances/,
      );
    },
  );
  await as(admin, () =>
    db.query(
      "insert into garden_income(business_date,category_id,amount_cents)values('2020-10-01',$1,1500000)",
      [incomeCat],
    ),
  );
  let settlement = "";
  await t.test(
    "₱10,000 net with 50% rates withholds ₱2,000 each; simultaneous retries never recover twice",
    async () => {
      const p = await preview();
      assert.equal(p.net_cents, 1000000);
      assert.deepEqual(
        p.owners.map((o) => o.withheld),
        [200000, 200000, 0],
      );
      assert.deepEqual(
        p.owners.map((o) => o.payable),
        [200000, 200000, 200000],
      );
      settlement = randomUUID();
      const result = await as(admin, () =>
        Promise.all(
          [0, 1].map(() =>
            db.query("select garden_partner_command($1,$2,$3) v", [
              "settle",
              settlement,
              JSON.stringify({ month: p.month, fingerprint: p.fingerprint }),
            ]),
          ),
        ),
      );
      assert.deepEqual(result[0].rows, result[1].rows);
      assert.equal(
        (await one("select count(*)::int n from garden_owner_recoveries")).n,
        2,
      );
      const after = await preview();
      assert.equal(
        after.active_settlement!.snapshot.owners[0].debt_after,
        5400000,
      );
      assert.equal(after.can_post, false);
      await assert.rejects(
        cmd("void_funding", {
          funding_id: funding,
          reason: "Fix supplier reference",
        }),
        /Reverse its owner settlements/,
      );
    },
  );
  await t.test(
    "cash payouts are capped after deductions; stale source inputs require review and explicit reversal",
    async () => {
      await assert.rejects(
        as(admin, () =>
          db.query(
            "insert into garden_payouts(owner,settlement_month,paid_on,amount_cents)values('Genesis','2020-10-01','2020-11-01',200001)",
          ),
        ),
        /exceeds the confirmed/,
      );
      await as(admin, () =>
        db.query(
          "insert into garden_payouts(owner,settlement_month,paid_on,amount_cents)values('Genesis','2020-10-01','2020-11-01',200000)",
        ),
      );
      await as(admin, () =>
        db.query(
          "update garden_income set amount_cents=1000000 where business_date='2020-10-01'",
        ),
      );
      assert.equal((await preview()).needs_review, true);
      await assert.rejects(
        cmd("reverse_settlement", { settlement_id: settlement, reason: "" }),
        /reason/,
      );
      await cmd("reverse_settlement", {
        settlement_id: settlement,
        reason: "Correct income amount",
      });
      const p = await preview();
      assert.equal(p.owners[0].withheld, 0);
      assert.equal(p.owners[0].debt_before, 5600000);
      assert.equal(p.owners[1].withheld, 100000);
      await as(admin, () =>
        db.query(
          "update garden_income set amount_cents=900000 where business_date='2020-10-01'",
        ),
      );
      await assert.rejects(
        cmd("settle", { month: p.month, fingerprint: p.fingerprint }),
        /changed after preview/,
      );
      assert.equal(
        (await one("select count(*)::int n from garden_payouts")).n,
        1,
      );
    },
  );
  await t.test(
    "missing rates, current months, losses and prior cash payouts are handled without negative recovery",
    async () => {
      const current = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
      }).format(new Date());
      const ym =
        new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Asia/Manila",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .format(new Date())
          .slice(0, 7) + "-01";
      assert.equal((await preview(ym)).can_post, false);
      await as(admin, () =>
        db.query(
          "insert into garden_income(business_date,category_id,amount_cents)values('2020-11-01',$1,1000000)",
          [incomeCat],
        ),
      );
      await as(admin, () =>
        db.query(
          "insert into garden_payouts(owner,settlement_month,paid_on,amount_cents)values('Genesis','2020-11-01','2020-11-10',300000)",
        ),
      );
      let p = await preview("2020-11-01");
      assert.equal(p.owners[0].withheld, 100000);
      await cmd("rule", {
        owner: "Genesis",
        effective_month: "2020-11-01",
        rate_bps: 0,
        reason: "Pause recovery",
      });
      p = await preview("2020-11-01");
      assert.equal(p.owners[0].withheld, 0);
      await as(admin, () =>
        db.query(
          "update garden_income set amount_cents=-100 where business_date='2020-11-01'",
        ),
      );
      p = await preview("2020-11-01");
      assert(p.owners.every((o) => o.withheld === 0));
      assert.equal(p.owners[0].payable, -300000);
    },
  );
  await t.test(
    "corrections restore obligations and cash records, while keeping audited originals and legacy loans",
    async () => {
      await cmd("void_reimbursement", {
        payment_id: payment,
        reason: "Incorrect payment entry; no cash was paid",
      });
      assert.equal(
        (await one("select count(*)::int n from garden_expenses")).n,
        0,
      );
      assert.equal(
        (await one("select count(*)::int n from garden_cash_allocations")).n,
        0,
      );
      assert(
        (
          await one(
            "select voided_at from garden_partner_payments where id=$1",
            [payment],
          )
        ).voided_at,
      );
      await cmd("void_funding", {
        funding_id: funding,
        reason: "Incorrect funding entry; supplier not paid",
      });
      assert.equal(
        (await one("select count(*)::int n from garden_cash_movements")).n,
        0,
      );
      assert.equal(
        (
          await one(
            "select total_cents::text n from garden_installments where id=$1",
            [legacy],
          )
        ).n,
        "20545796",
      );
      assert.equal(
        (
          await as(hr, () =>
            db.query(
              "select id from garden_audit where table_name like 'garden_partner_%' or table_name in ('garden_owner_settlements','garden_owner_recoveries')",
            ),
          )
        ).rows.length,
        0,
      );
      await db.query("update garden_profiles set active=false where id=$1", [
        admin,
      ]);
      await assert.rejects(preview(), /Finance management/);
    },
  );
  await db.close();
});
