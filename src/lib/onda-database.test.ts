import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import {
  buildOndaPreview,
  type OndaContext,
  type OndaReport,
  type OndaResolution,
} from "./onda";
import { report, refund, tx } from "../../scripts/onda-fixtures";
test("Onda database confirmation permissions, immutable evidence, conflicts and atomic retries", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } }),
    admin = randomUUID(),
    viewer = randomUUID(),
    employee = randomUUID(),
    hr = randomUUID(),
    another = randomUUID();
  await db.exec(
    "create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;",
  );
  for (const id of [admin, viewer, employee, hr, another])
    await db.query<Record<string, unknown>>(
      "insert into auth.users values($1)",
      [id],
    );
  for (const file of (await fs.readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(await fs.readFile("supabase/migrations/" + file, "utf8"));
  await db.query<Record<string, unknown>>(
    "insert into garden_profiles(id,display_name,role,finance_access,team_access)values($1,'Finance','admin',true,false),($2,'Viewer','viewer',true,false),($3,'Employee','employee',false,false),($4,'HR','admin',false,true),($5,'Other finance','admin',true,false)",
    [admin, viewer, employee, hr, another],
  );
  async function as<T>(
    uid: string | null,
    fn: () => Promise<T>,
    role = "authenticated",
  ) {
    await db.exec("set role " + role);
    await db.query<Record<string, unknown>>(
      "select set_config('request.jwt.claim.sub',$1,false)",
      [uid || ""],
    );
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
    }
  }
  const service = <T>(fn: () => Promise<T>) => as(null, fn, "service_role");
  const context = async () =>
    (
      await service(() =>
        db.query<{ v: OndaContext }>("select garden_onda_context($1) v", [
          admin,
        ]),
      )
    ).rows[0].v;
  const stage = async (r: OndaReport) => {
    const c = await context(),
      plan = buildOndaPreview(r, c),
      id = randomUUID(),
      hash = createHash("sha256").update(id).digest("hex");
    const saved = (
      await service(() =>
        db.query<{ v: { id: string } }>(
          "select garden_onda_prepare($1,$2,$3,$4,$5,$6,$7,$8) v",
          [
            admin,
            id,
            hash,
            "Fictional.pdf",
            1000,
            JSON.stringify(r),
            JSON.stringify(plan),
            c.fingerprint,
          ],
        ),
      )
    ).rows[0].v;
    return { id: saved.id, plan };
  };
  const confirm = (id: string, choices: Record<string, OndaResolution> = {}) =>
    service(() =>
      db.query<{
        v: {
          inserted: number;
          updated: number;
          unchanged: number;
          change_cents: number;
        };
      }>("select garden_onda_confirm($1,$2,$3) v", [
        admin,
        id,
        JSON.stringify(choices),
      ]),
    );
  const cat = (
      await db.query<{ id: string }>(
        "select id from garden_categories where name='Court rental'",
      )
    ).rows[0].id,
    manual = randomUUID();
  await as(admin, () =>
    db.query<Record<string, unknown>>(
      "insert into garden_income(id,business_date,category_id,amount_cents,notes)values($1,'2020-11-01',$2,95000,'Manual note')",
      [manual, cat],
    ),
  );
  await t.test(
    "only service RPCs with an active finance actor may touch private evidence",
    async () => {
      for (const uid of [admin, viewer, employee, hr])
        await assert.rejects(
          as(uid, () =>
            db.query<Record<string, unknown>>(
              "select garden_onda_context($1)",
              [uid],
            ),
          ),
          (e) => (e as { code: string }).code === "42501",
        );
      await assert.rejects(
        as(
          null,
          () =>
            db.query<Record<string, unknown>>(
              "select garden_onda_context($1)",
              [admin],
            ),
          "anon",
        ),
        (e) => (e as { code: string }).code === "42501",
      );
      for (const uid of [viewer, employee, hr])
        await assert.rejects(
          service(() =>
            db.query<Record<string, unknown>>(
              "select garden_onda_context($1)",
              [uid],
            ),
          ),
          (e) => (e as { code: string }).code === "42501",
        );
      await assert.rejects(
        as(viewer, () =>
          db.query<Record<string, unknown>>(
            "select * from garden_onda_imports",
          ),
        ),
        (e) => (e as { code: string }).code === "42501",
      );
    },
  );
  const first = report([
      tx("BK-SAFE01", "2020-11-01", 90000),
      tx("ER-SAFE02", "2020-11-01", 30000),
    ]),
    one = await stage(first);
  await t.test(
    "manual overlap must be resolved; separate extras and notes are preserved",
    async () => {
      await assert.rejects(confirm(one.id), /Resolve every/);
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select count(*)::int n from garden_income",
          )
        ).rows[0].n,
        1,
      );
      const attempts = await service(() =>
        Promise.all(
          [0, 1].map(() =>
            db.query<{
              v: {
                inserted: number;
                updated: number;
                unchanged: number;
                change_cents: number;
              };
            }>("select garden_onda_confirm($1,$2,$3) v", [
              admin,
              one.id,
              JSON.stringify({
                "2020-11-01/BK": { mode: "manual", amount_cents: 5000 },
              }),
            ]),
          ),
        ),
      );
      const result = attempts[0].rows[0].v;
      assert.deepEqual(attempts[1].rows[0].v, result);
      assert.equal(result.inserted, 1);
      assert.equal(result.unchanged, 1);
      assert.equal(result.change_cents, 30000);
      const row = (
        await db.query<Record<string, unknown>>(
          "select amount_cents,notes from garden_income where id=$1",
          [manual],
        )
      ).rows[0];
      assert.equal(Number(row.amount_cents), 95000);
      assert.equal(row.notes, "Manual note");
      const retry = (await confirm(one.id)).rows[0].v;
      assert.deepEqual(retry, result);
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select count(*)::int n from garden_income",
          )
        ).rows[0].n,
        2,
      );
    },
  );
  const next = report(
      [...first.transactions, tx("BK-SAFE03", "2020-11-01", 30000)],
      [refund("ER-SAFE02", "2020-11-02", 5000)],
      { generatedAt: "2020-11-08T00:00:00.000Z" },
    ),
    two = await stage(next);
  await t.test(
    "new reference is counted once and a refund-only day becomes negative income",
    async () => {
      const result = (await confirm(two.id)).rows[0].v;
      assert.equal(result.inserted, 1);
      assert.equal(result.updated, 1);
      assert.equal(result.change_cents, 25000);
      const totals = (
        await db.query<Record<string, unknown>>(
          "select sum(amount_cents)::text total from garden_income",
        )
      ).rows[0].total;
      assert.equal(totals, "150000");
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select count(*)::int n from garden_expenses",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select count(*)::int n from garden_cash_movements",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select count(*)::int n from garden_onda_refunds",
          )
        ).rows[0].n,
        1,
      );
      const older = await stage(first);
      const retry = (await confirm(older.id)).rows[0].v;
      assert.equal(retry.change_cents, 0);
      assert.equal(retry.inserted, 0);
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select sum(amount_cents)::text total from garden_income",
          )
        ).rows[0].total,
        "150000",
      );
    },
  );
  await t.test(
    "stale and expired previews cannot overwrite manual changes; refresh detects the conflict",
    async () => {
      const pending = await stage({
        ...next,
        generatedAt: "2020-11-09T00:00:00.000Z",
      });
      await as(admin, () =>
        db.query<Record<string, unknown>>(
          "update garden_income set amount_cents=126000 where id=$1",
          [manual],
        ),
      );
      await assert.rejects(
        confirm(pending.id),
        (e) => (e as { code: string }).code === "40001",
      );
      const c = await context(),
        plan = buildOndaPreview(
          { ...next, generatedAt: "2020-11-09T00:00:00.000Z" },
          c,
        );
      assert(plan.proposals.find((p) => p.key === "2020-11-01/BK")!.conflict);
      await service(() =>
        db.query<Record<string, unknown>>(
          "select garden_onda_refresh($1,$2,$3,$4)",
          [admin, pending.id, JSON.stringify(plan), c.fingerprint],
        ),
      );
      await db.query<Record<string, unknown>>(
        "update garden_onda_imports set expires_at=now()-interval '1 minute' where id=$1",
        [pending.id],
      );
      await assert.rejects(
        confirm(pending.id, { "2020-11-01/BK": { mode: "replace" } }),
        /expired/,
      );
      await assert.rejects(
        service(() =>
          db.query<Record<string, unknown>>(
            "select garden_onda_refresh($1,$2,$3,$4)",
            [another, pending.id, JSON.stringify(plan), c.fingerprint],
          ),
        ),
        /not found/,
      );
    },
  );
  await t.test(
    "account allocations block reducing an imported total and are never removed by import",
    async () => {
      await as(admin, () =>
        db.query<Record<string, unknown>>(
          "select garden_cash_setup('2020-11-01',0,0,0)",
        ),
      );
      const allocation = randomUUID();
      await as(admin, () =>
        db.query<Record<string, unknown>>(
          "select garden_cash_allocate($1,'income',$2,'cash',126000)",
          [allocation, manual],
        ),
      );
      const pending = await stage({
        ...next,
        generatedAt: "2020-11-10T00:00:00.000Z",
      });
      await assert.rejects(
        confirm(pending.id, { "2020-11-01/BK": { mode: "replace" } }),
        /account assignments/,
      );
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select amount_cents::text n from garden_income where id=$1",
            [manual],
          )
        ).rows[0].n,
        "126000",
      );
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select count(*)::int n from garden_cash_allocations",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.query<Record<string, unknown>>(
            "select state from garden_onda_imports where id=$1",
            [pending.id],
          )
        ).rows[0].state,
        "preview",
      );
    },
  );
  await t.test(
    "a later conflict rolls back earlier changes and duplicate file confirmations do nothing",
    async () => {
      const openCat = (
        await db.query<{ id: string }>(
          "select id from garden_categories where name='Open play'",
        )
      ).rows[0].id;
      await as(admin, () =>
        db.query(
          "insert into garden_income(business_date,category_id,amount_cents,notes)values('2020-11-03',$1,20000,'Outside total')",
          [openCat],
        ),
      );
      const r = report(
        [
          tx("BK-ATOMIC1", "2020-11-03", 30000),
          tx("ER-ATOMIC2", "2020-11-03", 20000),
        ],
        [],
        {
          start: "2020-11-03",
          end: "2020-11-03",
          generatedAt: "2020-11-10T04:00:00.000Z",
        },
      );
      const staged = await stage(r);
      await assert.rejects(confirm(staged.id), /Resolve every/);
      assert.equal(
        (
          await db.query(
            "select id from garden_income where business_date='2020-11-03' and category_id=$1",
            [cat],
          )
        ).rows.length,
        0,
      );
      assert.equal(
        (
          await db.query(
            "select reference from garden_onda_transactions where reference='BK-ATOMIC1'",
          )
        ).rows.length,
        0,
      );
      assert.equal(
        (
          await db.query<{ state: string }>(
            "select state from garden_onda_imports where id=$1",
            [staged.id],
          )
        ).rows[0].state,
        "preview",
      );
      const result = (
        await confirm(staged.id, { "2020-11-03/ER": { mode: "replace" } })
      ).rows[0].v;
      assert.equal(result.inserted, 1);
      const c = await context(),
        duplicate = randomUUID();
      const hash = (
        await db.query<{ sha256: string }>(
          "select sha256 from garden_onda_imports where id=$1",
          [staged.id],
        )
      ).rows[0].sha256;
      await service(() =>
        db.query(
          "select garden_onda_prepare($1,$2,$3,'Duplicate.pdf',1000,$4,$5,$6)",
          [
            admin,
            duplicate,
            hash,
            JSON.stringify(r),
            JSON.stringify(buildOndaPreview(r, c)),
            c.fingerprint,
          ],
        ),
      );
      const again = (await confirm(duplicate)).rows[0].v;
      assert.equal(again.inserted, result.inserted);
      assert.equal(
        (
          await db.query(
            "select id from garden_income where business_date='2020-11-03'",
          )
        ).rows.length,
        2,
      );
      assert.equal(
        (
          await db.query(
            "select id from garden_onda_imports where state='confirmed' and sha256=$1",
            [hash],
          )
        ).rows.length,
        1,
      );
    },
  );
  await t.test(
    "disabled finance actors and HR audit readers cannot access import evidence",
    async () => {
      await db.query<Record<string, unknown>>(
        "update garden_profiles set active=false where id=$1",
        [admin],
      );
      await assert.rejects(
        service(() =>
          db.query<Record<string, unknown>>("select garden_onda_context($1)", [
            admin,
          ]),
        ),
        (e) => (e as { code: string }).code === "42501",
      );
      const history = await as(hr, () =>
        db.query<Record<string, unknown>>(
          "select id from garden_audit where table_name='garden_onda_imports'",
        ),
      );
      assert.equal(history.rows.length, 0);
    },
  );
  await db.close();
});
