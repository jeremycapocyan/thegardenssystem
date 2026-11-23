import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import type { CapitalEqualization } from "./capital-equality";
import type { PartnerPreview } from "./partners";
test("equal-capital transaction rules preserve contributions and deduct only confirmed repayments", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } }),
    admin = randomUUID(),
    viewer = randomUUID(),
    employee = randomUUID(),
    hr = randomUUID();
  await db.exec(
    "create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;",
  );
  for (const id of [admin, viewer, employee, hr])
    await db.query("insert into auth.users values($1)", [id]);
  for (const file of (await fs.readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await fs.readFile("supabase/migrations/" + file, "utf8"));
  await db.query(
    "insert into garden_profiles(id,display_name,role,finance_access,team_access)values($1,'Admin','admin',true,false),($2,'Viewer','viewer',true,false),($3,'Employee','employee',false,false),($4,'HR','admin',false,true)",
    [admin, viewer, employee, hr],
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
  const preview = async () =>
    (
      await as(admin, () =>
        db.query<{ v: CapitalEqualization }>(
          "select garden_partner_equalization(11200000) v",
        ),
      )
    ).rows[0].v;
  const cmd = async (
    a: string,
    p: Record<string, unknown>,
    id = randomUUID(),
  ) =>
    (
      await as(admin, () =>
        db.query<{ v: any }>("select garden_partner_command($1,$2,$3)v", [
          a,
          id,
          JSON.stringify(p),
        ]),
      )
    ).rows[0].v;
  const g = randomUUID(),
    k = randomUUID();
  await as(admin, () =>
    db.query(
      "insert into garden_capital(id,invested_on,owner,amount_cents)values($1,'2020-01-01','Genesis',8000000),($2,'2020-01-01','Ken',6000000)",
      [g, k],
    ),
  );
  await as(admin, () =>
    db.query("select garden_cash_setup('2020-01-01',20000000,0,0)"),
  );
  await t.test(
    "only active finance admins can calculate equalization",
    async () => {
      for (const uid of [viewer, employee, hr])
        await assert.rejects(
          as(uid, () =>
            db.query("select garden_partner_equalization(11200000)"),
          ),
          /Finance management/,
        );
    },
  );
  const first = await preview();
  await t.test(
    "supplier funding is allocated from total capital, not split blindly in half",
    async () => {
      assert.equal(first.target_cents, 12600000);
      assert.deepEqual(
        first.allocations.map((a) => a.amount_cents),
        [4600000, 6600000],
      );
      await assert.rejects(
        as(admin, () =>
          db.query("select garden_partner_equalization(11200001)"),
        ),
        /half a centavo/,
      );
      await assert.rejects(
        as(admin, () =>
          db.query("select garden_partner_equalization(1000000)"),
        ),
        /too small/,
      );
    },
  );
  const payload = {
    supplier: "Fictional supplier",
    purpose: "Equal-capital purchase",
    total_cents: 11200000,
    start_month: "2020-01-01",
    equalize_capital: true,
    capital_fingerprint: first.fingerprint,
    partners: first.allocations.map((a) => ({ ...a, rate_bps: 5000 })),
  };
  await t.test(
    "manual unequal totals and stale previews cannot create a draft",
    async () => {
      await assert.rejects(
        cmd("funding_draft", {
          ...payload,
          partners: [
            { owner: "Genesis", amount_cents: 5600000, rate_bps: 5000 },
            { owner: "Ken", amount_cents: 5600000, rate_bps: 5000 },
          ],
        }),
        /equalize/,
      );
      await as(admin, () =>
        db.query(
          "update garden_capital set amount_cents=amount_cents+200 where id=$1",
          [k],
        ),
      );
      await assert.rejects(
        cmd("funding_draft", payload),
        (e) => (e as { code: string }).code === "40001",
      );
      assert.equal(
        (await db.query("select id from garden_partner_fundings")).rows.length,
        0,
      );
      await as(admin, () =>
        db.query(
          "update garden_capital set amount_cents=amount_cents-200 where id=$1",
          [k],
        ),
      );
    },
  );
  const draft = randomUUID();
  await cmd("funding_draft", payload, draft);
  await t.test(
    "funding rechecks capital versions and saves nothing if a contribution changed",
    async () => {
      await as(admin, () =>
        db.query(
          "update garden_capital set amount_cents=amount_cents+2000 where id=$1",
          [k],
        ),
      );
      await assert.rejects(
        cmd("fund", {
          funding_id: draft,
          paid_on: "2020-01-15",
          account: "cash",
        }),
        /Capital changed/,
      );
      assert.equal(
        (await db.query("select id from garden_cash_movements")).rows.length,
        0,
      );
      await as(admin, () =>
        db.query(
          "update garden_capital set amount_cents=amount_cents-2000 where id=$1",
          [k],
        ),
      );
    },
  );
  await cmd("fund", {
    funding_id: draft,
    paid_on: "2020-01-15",
    account: "cash",
  });
  await t.test(
    "recorded capital rows are unchanged and funded credits make both totals equal",
    async () => {
      assert.deepEqual(
        (
          await db.query<{ amount_cents: bigint }>(
            "select amount_cents from garden_capital order by owner",
          )
        ).rows.map((r) => Number(r.amount_cents)),
        [8000000, 6000000],
      );
      assert.equal(
        (await db.query("select id from garden_expenses")).rows.length,
        0,
      );
      const next = await preview();
      assert.deepEqual(
        next.positions.map((p) => p.credited_cents),
        [12600000, 12600000],
      );
      assert.deepEqual(
        next.allocations.map((a) => a.amount_cents),
        [5600000, 5600000],
      );
    },
  );
  await t.test(
    "automatic share deductions settle unequal advances without double-counting capital",
    async () => {
      const category = (
        await db.query<{ id: string }>(
          "select id from garden_categories where kind='income' limit 1",
        )
      ).rows[0].id;
      await as(admin, () =>
        db.query(
          "insert into garden_income(business_date,category_id,amount_cents)values('2020-01-01',$1,1000000)",
          [category],
        ),
      );
      const s = (
        await as(admin, () =>
          db.query<{ v: PartnerPreview }>(
            "select garden_partner_preview('2020-01-01')v",
          ),
        )
      ).rows[0].v;
      assert.deepEqual(
        s.owners.map((o) => o.withheld),
        [200000, 200000, 0],
      );
      await cmd("settle", { month: s.month, fingerprint: s.fingerprint });
      const next = await preview();
      assert.deepEqual(
        next.positions.map((p) => p.credited_cents),
        [12600000, 12600000],
      );
      assert.deepEqual(
        next.positions.map((p) => p.outstanding_cents),
        [4400000, 6400000],
      );
      assert.equal(
        (await db.query("select id from garden_capital")).rows.length,
        2,
      );
      assert.equal(
        (await db.query("select id from garden_cash_movements")).rows.length,
        1,
      );
    },
  );
  await db.close();
});
