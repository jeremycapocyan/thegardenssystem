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
          await one(
            action.startsWith("edit_")
              ? "select garden_partner_cash_edit($1,$2,$3) v"
              : "select garden_partner_cash_command($1,$2,$3) v",
            [action, id, JSON.stringify(payload)],
          )
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
  const advanceRecord = async (id: string) =>
    (
      await one(
        "select to_jsonb(a) v from garden_partner_cash_advances a where id=$1",
        [id],
      )
    ).v;
  const repaymentRecord = async (id: string) =>
    (
      await one(
        "select to_jsonb(r) v from garden_partner_cash_repayments r where id=$1",
        [id],
      )
    ).v;
  const advanceEdit = (a: any, extra: Record<string, unknown> = {}) => ({
    record_id: a.id,
    expected: a,
    owner: a.owner,
    purpose: a.purpose,
    received_on: a.received_on,
    amount_cents: a.amount_cents,
    monthly_cents: a.monthly_cents,
    first_due: a.first_due,
    account: a.detail.to_account,
    reference: a.detail.reference,
    reason: "Fictional correction",
    ...extra,
  });
  const repaymentEdit = (r: any, extra: Record<string, unknown> = {}) => ({
    record_id: r.id,
    expected: r,
    paid_on: r.paid_on,
    amount_cents: r.amount_cents,
    account: r.detail.from_account,
    reference: r.detail.reference,
    reason: "Fictional correction",
    ...extra,
  });
  await t.test(
    "editing a receipt preserves IDs and updates its single cash movement and terms",
    async () => {
      const id = (await receive({ amount_cents: 10000, monthly_cents: 5000 }))
          .id,
        a = await advanceRecord(id),
        key = randomUUID();
      const payload = advanceEdit(a, {
        owner: "Ken",
        purpose: "Corrected purpose",
        amount_cents: 12000,
        monthly_cents: 4000,
        received_on: "2020-01-02",
        first_due: "2020-03-31",
        account: "bank",
        reference: "corrected",
      });
      const before = await one(
        "select count(*)::int n from garden_cash_movements",
      );
      const result = await cmd("edit_receipt", payload, key);
      assert.deepEqual(await cmd("edit_receipt", payload, key), result);
      const after = await advanceRecord(id);
      assert.equal(after.receipt_id, a.receipt_id);
      assert.equal(after.amount_cents, 12000);
      assert.equal(after.owner, "Ken");
      assert.equal(after.first_due, "2020-03-31");
      assert.equal(after.detail.to_account, "bank");
      assert.equal(after.detail.amount_cents, 12000);
      assert.equal(after.detail.reference, "corrected");
      assert.equal(
        (await one("select count(*)::int n from garden_cash_movements")).n,
        before.n,
      );
      await assert.rejects(
        cmd("edit_receipt", { ...payload, purpose: "Another" }, key),
        /Retry key/,
      );
    },
  );
  await t.test(
    "edits protect repayments, funding links and chronological dates without partial changes",
    async () => {
      const id = (await receive({ amount_cents: 20000, monthly_cents: 10000 }))
        .id;
      await buy(id, { amount_cents: 6000, total_cents: 6000 });
      await repay(id, { amount_cents: 5000 });
      const a = await advanceRecord(id);
      await assert.rejects(
        cmd(
          "edit_receipt",
          advanceEdit(a, { amount_cents: 5500, monthly_cents: 5000 }),
        ),
        /lower than/,
      );
      await assert.rejects(
        cmd("edit_receipt", advanceEdit(a, { received_on: "2020-01-03" })),
        /after a linked/,
      );
      await assert.rejects(
        cmd("edit_receipt", advanceEdit(a, { owner: "Ken" })),
        /changing the partner/,
      );
      assert.deepEqual(await advanceRecord(id), a);
      await cmd(
        "edit_receipt",
        advanceEdit(a, {
          purpose: "Allowed correction",
          first_due: "2020-04-01",
        }),
      );
      assert.equal((await advanceRecord(id)).purpose, "Allowed correction");
    },
  );
  await t.test(
    "repayment edits adjust the same outflow and enforce the remaining principal",
    async () => {
      const id = (await receive({ amount_cents: 10000, monthly_cents: 10000 }))
          .id,
        rep = (await repay(id, { amount_cents: 4000 })).id;
      const before = await repaymentRecord(rep),
        payload = repaymentEdit(before, {
          amount_cents: 6000,
          paid_on: "2020-03-01",
          account: "bank",
          reference: "corrected payment",
        }),
        key = randomUUID();
      await cmd("edit_repayment", payload, key);
      await cmd("edit_repayment", payload, key);
      const after = await repaymentRecord(rep);
      assert.equal(after.movement_id, before.movement_id);
      assert.equal(after.amount_cents, 6000);
      assert.equal(after.detail.from_account, "bank");
      assert.equal(after.detail.amount_cents, 6000);
      assert.equal(after.detail.reference, "corrected payment");
      await assert.rejects(
        cmd("edit_repayment", repaymentEdit(after, { amount_cents: 10001 })),
        /outstanding debt/,
      );
      await assert.rejects(
        cmd("edit_repayment", repaymentEdit(after, { paid_on: "2019-12-31" })),
        /on or after receipt/,
      );
      assert.deepEqual(await repaymentRecord(rep), after);
      await cmd("void_repayment", {
        record_id: rep,
        reason: "Remove incorrect payment",
      });
      await cmd("void_receipt", {
        record_id: id,
        reason: "Remove original incorrect advance",
      });
      assert.ok((await advanceRecord(id)).voided_at);
    },
  );
  await t.test(
    "stale edits, missing reasons and unauthorized roles cannot overwrite finance",
    async () => {
      const id = (await receive({ amount_cents: 10000, monthly_cents: 10000 }))
          .id,
        a = await advanceRecord(id);
      await cmd(
        "edit_receipt",
        advanceEdit(a, { purpose: "First correction" }),
      );
      await assert.rejects(
        cmd("edit_receipt", advanceEdit(a, { purpose: "Stale correction" })),
        /changed/,
      );
      const current = await advanceRecord(id);
      await assert.rejects(
        cmd("edit_receipt", advanceEdit(current, { reason: "" })),
        /reason/,
      );
      for (const actor of [viewer, employee, hr, disabled])
        await assert.rejects(
          cmd("edit_receipt", advanceEdit(current), randomUUID(), actor),
          /Finance management/,
        );
      await db.exec("set role anon");
      await assert.rejects(
        db.query("select garden_partner_cash_edit('edit_receipt',$1,'{}')", [
          randomUUID(),
        ]),
        /permission denied/,
      );
      await db.exec("reset role");
    },
  );
  await t.test(
    "linked pre-existing receipts retain their cash values when metadata is edited",
    async () => {
      const mid = randomUUID();
      await as(admin, () =>
        db.query(
          "select garden_cash_move($1,'2020-05-01','funding',null,'cash',10000,'old','Existing cash receipt')",
          [mid],
        ),
      );
      const id = (
        await receive({
          received_on: "2020-05-01",
          first_due: "2020-06-01",
          amount_cents: 10000,
          monthly_cents: 10000,
          movement_id: mid,
        })
      ).id;
      const a = await advanceRecord(id);
      await cmd(
        "edit_receipt",
        advanceEdit(a, {
          purpose: "Clarified purpose",
          first_due: "2020-07-01",
        }),
      );
      const current = await advanceRecord(id);
      await assert.rejects(
        cmd("edit_receipt", advanceEdit(current, { amount_cents: 12000 })),
        /pre-existing receipt/,
      );
      await assert.rejects(
        cmd("edit_receipt", advanceEdit(current, { account: "bank" })),
        /pre-existing receipt/,
      );
      const paymentMovement = randomUUID();
      await as(admin, () =>
        db.query(
          "select garden_cash_move($1,'2020-05-02','funding','cash',null,3000,'manual repayment','Existing repayment')",
          [paymentMovement],
        ),
      );
      const payment = (
        await repay(id, {
          paid_on: "2020-05-02",
          amount_cents: 3000,
          movement_id: paymentMovement,
        })
      ).id;
      await assert.rejects(
        cmd(
          "edit_repayment",
          repaymentEdit(await repaymentRecord(payment), { amount_cents: 2000 }),
        ),
        /pre-existing movement/,
      );
      await cmd("void_repayment", {
        record_id: payment,
        reason: "Remove wrong repayment link",
      });
      assert.equal(
        (
          await one(
            "select count(*)::int n from garden_cash_movements where id=$1",
            [paymentMovement],
          )
        ).n,
        1,
      );
      await cmd("void_receipt", { record_id: id, reason: "Remove wrong link" });
      assert.equal(
        (
          await one(
            "select count(*)::int n from garden_cash_movements where id=$1",
            [mid],
          )
        ).n,
        1,
      );
    },
  );
  await t.test(
    "distribution preview is reversible, stale-safe and reconciles monthly FIFO reimbursements",
    async () => {
      const baseline = await as(
        admin,
        async () =>
          (
            await one(
              "select garden_distribution_basis('2020-03-01','2020-03-31') v",
            )
          ).v,
      );
      const a = await receive({
        received_on: "2020-03-01",
        first_due: "2020-04-30",
        amount_cents: 5000000,
        monthly_cents: 5000000,
      });
      const p1 = await buy(a.id, {
        paid_on: "2020-03-02",
        amount_cents: 2000000,
        total_cents: 3000000,
      });
      const p2 = await buy(a.id, {
        paid_on: "2020-03-03",
        amount_cents: 1000000,
        total_cents: 1000000,
      });
      const basis = (start: string, end: string) =>
        as(
          admin,
          async () =>
            (
              await one("select garden_distribution_basis($1,$2) v", [
                start,
                end,
              ])
            ).v,
        );
      const march = await basis("2020-03-01", "2020-03-31");
      assert.equal(
        march.operating_result_cents - baseline.operating_result_cents,
        -4000000,
      );
      assert.equal(
        march.funded_purchases_cents - baseline.funded_purchases_cents,
        3000000,
      );
      assert.equal(
        march.payout_basis_cents - baseline.payout_basis_cents,
        -1000000,
      );
      const id = randomUUID(),
        payload = {
          advance_id: a.id,
          paid_on: "2020-04-01",
          amount_cents: 4000000,
          account: "cash",
        };
      const counts = () =>
        one(
          "select (select count(*)::int from garden_expenses) expenses,(select count(*)::int from garden_cash_movements) movements,(select count(*)::int from garden_partner_cash_actions) actions,(select count(*)::int from garden_audit) audit",
        );
      const before = await counts();
      const preview = () =>
        as(
          admin,
          async () =>
            (
              await one("select garden_partner_cash_preview('repay',$1,$2) v", [
                id,
                JSON.stringify(payload),
              ])
            ).v,
        );
      const reviewed = await preview();
      assert.deepEqual(await counts(), before);
      assert.equal(reviewed.repayment.reimbursed_cost_cents, 3000000);
      assert.equal(reviewed.repayment.unused_return_cents, 1000000);
      assert.deepEqual(reviewed.repayment.allocations, [
        { spend_id: p1.id, amount_cents: 2000000 },
        { spend_id: p2.id, amount_cents: 1000000 },
      ]);
      // Another finance action invalidates a reviewed save; the failed save changes nothing.
      await receive({
        received_on: "2020-03-04",
        first_due: "2020-04-30",
        amount_cents: 100,
        monthly_cents: 100,
      });
      const changed = await counts();
      await assert.rejects(
        cmd(
          "repay",
          { ...payload, distribution_expected: reviewed.fingerprint },
          id,
        ),
        /changed after review/,
      );
      assert.deepEqual(await counts(), changed);
      const refreshed = await preview();
      await cmd(
        "repay",
        { ...payload, distribution_expected: refreshed.fingerprint },
        id,
      );
      await cmd(
        "repay",
        { ...payload, distribution_expected: reviewed.fingerprint },
        id,
      ); // lost-response retry
      const after = await counts();
      assert.equal(after.expenses, before.expenses);
      assert.equal(after.movements, changed.movements + 1);
      const april = await basis("2020-04-01", "2020-04-30");
      assert.equal(
        april.events.find((e: any) => e.id === id).reimbursed_cost_cents,
        3000000,
      );
      assert.equal(
        april.events.find((e: any) => e.id === id).unused_return_cents,
        1000000,
      );
      const snap = await one(
        "select to_jsonb(t) v from garden_partner_cash_repayments t where id=$1",
        [id],
      );
      await assert.rejects(
        buy(a.id, {
          paid_on: "2020-04-02",
          amount_cents: 1500000,
          total_cents: 1500000,
        }),
        /cash retained/,
      );
      // Edits use the same complete-history validation and preview; preserve linked cash ID.
      const editPayload = {
        record_id: id,
        expected: snap.v,
        amount_cents: 3500000,
        account: "cash",
        reference: "",
        reason: "Fictional correction",
        paid_on: "2020-04-01",
      };
      const editId = randomUUID();
      const editPreview = await as(
        admin,
        async () =>
          (
            await one(
              "select garden_partner_cash_preview('edit_repayment',$1,$2) v",
              [editId, JSON.stringify(editPayload)],
            )
          ).v,
      );
      assert.equal(editPreview.repayment.reimbursed_cost_cents, 3000000);
      assert.equal(editPreview.repayment.unused_return_cents, 500000);
      await cmd(
        "edit_repayment",
        { ...editPayload, distribution_expected: editPreview.fingerprint },
        editId,
      );
      assert.equal(
        (
          await one(
            "select movement_id from garden_partner_cash_repayments where id=$1",
            [id],
          )
        ).movement_id,
        snap.v.movement_id,
      );
      for (const actor of [viewer, employee, hr, disabled]) {
        await assert.rejects(
          as(actor, () =>
            one("select garden_partner_cash_preview('repay',$1,$2)", [
              randomUUID(),
              JSON.stringify(payload),
            ]),
          ),
          (e: any) => e.code === "42501",
        );
      }
      await assert.rejects(
        as(employee, () =>
          one("select garden_distribution_basis('2020-03-01','2020-03-31')"),
        ),
        (e: any) => e.code === "42501",
      );
      await as(viewer, () =>
        one("select garden_distribution_basis('2020-03-01','2020-03-31')"),
      );
      for (const fn of [
        "garden_partner_cash_command_core",
        "garden_partner_cash_edit_core",
      ])
        await assert.rejects(
          as(admin, () =>
            one(`select ${fn}('repay',$1,$2)`, [
              randomUUID(),
              JSON.stringify(payload),
            ]),
          ),
          (e: any) => e.code === "42501",
        );
    },
  );
  await t.test(
    "monthly owner entitlements use payout basis and later repayment flags the frozen month",
    async () => {
      const a = await receive({
        received_on: "2020-09-01",
        first_due: "2020-10-31",
        amount_cents: 1000000,
        monthly_cents: 1000000,
      });
      await buy(a.id, {
        paid_on: "2020-09-02",
        amount_cents: 1000000,
        total_cents: 1000000,
      });
      await db.query(
        "insert into garden_income(business_date,category_id,amount_cents,notes) select '2020-09-02',id,2000000,'Fictional payout basis test' from garden_categories where kind='income' limit 1",
      );
      const preview = await as(
        admin,
        async () =>
          (await one("select garden_partner_preview('2020-09-01') v")).v,
      );
      assert.equal(preview.distribution.operating_result_cents, 1000000);
      assert.equal(preview.net_cents, 2000000);
      assert.deepEqual(
        preview.owners.map((o: any) => o.entitlement),
        [800000, 800000, 400000],
      );
      const sid = randomUUID();
      await as(admin, () =>
        one("select garden_partner_command('settle',$1,$2) v", [
          sid,
          JSON.stringify({
            month: "2020-09-01",
            fingerprint: preview.fingerprint,
          }),
        ]),
      );
      const frozen = await one(
        "select snapshot from garden_owner_settlements where id=$1",
        [sid],
      );
      await repay(a.id, { paid_on: "2020-09-15", amount_cents: 500000 });
      const updated = await as(
        admin,
        async () =>
          (await one("select garden_partner_preview('2020-09-01') v")).v,
      );
      assert.equal(updated.net_cents, 1500000);
      assert.equal(updated.needs_review, true);
      assert.deepEqual(
        (
          await one(
            "select snapshot from garden_owner_settlements where id=$1",
            [sid],
          )
        ).snapshot,
        frozen.snapshot,
      );
      assert.equal(
        (
          await one(
            "select net_cents::text n from garden_owner_settlements where id=$1",
            [sid],
          )
        ).n,
        "2000000",
      );
    },
  );
  await t.test(
    "later same-day repayments do not reassign a saved repayment's reimbursed costs",
    async () => {
      const a = await receive({
        received_on: "2020-10-01",
        first_due: "2020-10-31",
        amount_cents: 100000,
        monthly_cents: 100000,
      });
      await buy(a.id, {
        paid_on: "2020-10-02",
        amount_cents: 40000,
        total_cents: 40000,
      });
      const first = "ffffffff-ffff-4fff-8fff-fffffffffff1",
        second = "00000000-0000-4000-8000-000000000001";
      await cmd(
        "repay",
        {
          advance_id: a.id,
          paid_on: "2020-10-10",
          amount_cents: 40000,
          account: "cash",
        },
        first,
      );
      await cmd(
        "repay",
        {
          advance_id: a.id,
          paid_on: "2020-10-10",
          amount_cents: 10000,
          account: "cash",
        },
        second,
      );
      const basis = await as(
        admin,
        async () =>
          (
            await one(
              "select garden_distribution_basis('2020-10-01','2020-10-31') v",
            )
          ).v,
      );
      assert.equal(
        basis.events.find((e: any) => e.id === first).reimbursed_cost_cents,
        40000,
      );
      assert.equal(
        basis.events.find((e: any) => e.id === second).reimbursed_cost_cents,
        0,
      );
      assert.equal(
        basis.events.find((e: any) => e.id === second).unused_return_cents,
        10000,
      );
    },
  );
  await db.close();
});
