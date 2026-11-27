import {
  buildOndaAccountPreview,
  type OndaAccountContext,
} from "./onda-accounts";
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
    "transaction encoding preserves totals, posts Cash and Booking once, and safely upgrades daily imports",
    async () => {
      const r = report(
        [
          tx("BK-TRANS01", "2021-01-01", 90000),
          tx("ER-TRANS02", "2021-01-01", 30000, { method: "Cash" }),
        ],
        [refund("BK-TRANS01", "2021-01-02", 10000)],
      );
      const stageV2 = async (source = r) => {
        const c = (await context()) as OndaAccountContext,
          plan = buildOndaAccountPreview(source, c),
          id = randomUUID();
        assert.deepEqual(plan.blockers, []);
        const hash = createHash("sha256").update(id).digest("hex");
        await service(() =>
          db.query(
            "select garden_onda_prepare($1,$2,$3,'Transactions.pdf',1000,$4,$5,$6)",
            [
              admin,
              id,
              hash,
              JSON.stringify(source),
              JSON.stringify(plan),
              c.fingerprint,
            ],
          ),
        );
        return { id, plan };
      };
      const encode = (
        id: string,
        choices: Record<string, unknown> = {},
        accounts: Record<string, string> = {},
        replace = true,
      ) =>
        service(() =>
          db.query<any>(
            "select garden_onda_confirm_transactions($1,$2,$3,$4,$5) v",
            [
              admin,
              id,
              JSON.stringify(choices),
              JSON.stringify(accounts),
              replace,
            ],
          ),
        );
      r.start = "2021-01-01";
      r.end = "2021-01-02";
      r.generatedAt = "2021-01-03T04:00:00Z";
      const legacy = await stage(r);
      await confirm(legacy.id);
      const oldTotal = (
        await db.query<any>(
          "select sum(amount_cents)::text n from garden_income",
        )
      ).rows[0].n;
      const c1 = await context();
      const oldId = c1.links.find(
        (l) => l.business_date === "2021-01-01" && l.source_amount === 90000,
      )!.income_id;
      await as(admin, () =>
        db.query("select garden_cash_allocate($1,'income',$2,'cash',90000)", [
          randomUUID(),
          oldId,
        ]),
      );
      const preview = await stageV2();
      assert.equal(preview.plan.entries.length, 3);
      assert.equal(preview.plan.replaced_allocations, 1);
      await assert.rejects(
        encode(preview.id, {}, {}, false),
        /Review replacement/,
      );
      await encode(preview.id);
      await encode(preview.id);
      assert.equal(
        (
          await db.query<any>(
            "select sum(amount_cents)::text n from garden_income",
          )
        ).rows[0].n,
        oldTotal,
      );
      assert.equal(
        (
          await db.query<any>(
            "select amount_cents::text n,onda_hidden from garden_income where id=$1",
            [oldId],
          )
        ).rows[0].n,
        "0",
      );
      let rows = (
        await db.query<any>(
          "select i.id,i.onda_key,i.amount_cents::int,a.account,a.amount_cents::int assigned from garden_income i left join garden_cash_allocations a on a.income_id=i.id where i.onda_key in ('tx:BK-TRANS01','tx:ER-TRANS02','refund:BK-TRANS01/2021-01-02/10000/1') order by i.onda_key",
        )
      ).rows;
      assert.equal(rows.length, 3);
      assert.equal(
        rows.find((x) => x.onda_key === "tx:BK-TRANS01").account,
        "booking",
      );
      assert.equal(
        rows.find((x) => x.onda_key === "tx:ER-TRANS02").account,
        "cash",
      );
      assert.equal(
        rows.find((x) => x.onda_key.startsWith("refund:")).assigned,
        -10000,
      );
      const ids = rows.map((x) => x.id).sort();
      const repeat = await stageV2();
      assert.equal(
        repeat.plan.proposals.some((p) => p.conflict),
        false,
      );
      await encode(repeat.id);
      rows = (
        await db.query<any>(
          "select id from garden_income where onda_key in ('tx:BK-TRANS01','tx:ER-TRANS02','refund:BK-TRANS01/2021-01-02/10000/1')",
        )
      ).rows;
      assert.deepEqual(rows.map((x) => x.id).sort(), ids);
      await as(admin, () =>
        db.query("update garden_income set amount_cents=12345 where id=$1", [
          oldId,
        ]),
      );
      assert.equal(
        (
          await db.query<any>(
            "select onda_hidden from garden_income where id=$1",
            [oldId],
          )
        ).rows[0].onda_hidden,
        false,
      );
      await as(admin, () =>
        db.query("update garden_income set amount_cents=0 where id=$1", [
          oldId,
        ]),
      );
      assert.equal(
        (
          await db.query<any>(
            "select onda_hidden from garden_income where id=$1",
            [oldId],
          )
        ).rows[0].onda_hidden,
        true,
      );
      await assert.rejects(
        as(admin, () =>
          db.query("update garden_income set amount_cents=1 where id=$1", [
            ids[0],
          ]),
        ),
        (e: any) => e.code === "42501",
      );
      const newer = report(
        [
          tx("BK-TRANS01", "2021-01-01", 80000),
          tx("ER-TRANS02", "2021-01-01", 30000, { method: "Cash" }),
        ],
        [refund("BK-TRANS01", "2021-01-02", 10000)],
        {
          start: "2021-01-01",
          end: "2021-01-02",
          generatedAt: "2021-01-04T04:00:00Z",
        },
      );
      const correction = await stageV2(newer);
      await encode(correction.id);
      assert.equal(
        (
          await db.query<any>(
            "select amount_cents::int n from garden_income where onda_key='tx:BK-TRANS01'",
          )
        ).rows[0].n,
        80000,
      );
      const older = await stageV2();
      assert(older.plan.olderIgnored > 0);
      await encode(older.id);
      assert.equal(
        (
          await db.query<any>(
            "select amount_cents::int n from garden_income where onda_key='tx:BK-TRANS01'",
          )
        ).rows[0].n,
        80000,
      );
      await assert.rejects(
        as(viewer, () => db.query("select * from garden_onda_entry_links")),
        (e: any) => e.code === "42501",
      );
      const withManual = await stageV2({
        ...newer,
        generatedAt: "2021-01-05T04:00:00Z",
      });
      await encode(
        withManual.id,
        { "2021-01-01/BK": { mode: "manual", amount_cents: 500 } },
        { "manual:2021-01-01/BK": "bank" },
      );
      assert.equal(
        (
          await db.query<any>(
            "select amount_cents::int n from garden_income where id=$1",
            [oldId],
          )
        ).rows[0].n,
        500,
      );
      assert.equal(
        (
          await db.query<any>(
            "select amount_cents::int n,account from garden_cash_allocations where income_id=$1",
            [oldId],
          )
        ).rows[0].account,
        "bank",
      );
      const cancelled = await stageV2({
        ...newer,
        generatedAt: "2021-01-06T04:00:00Z",
        transactions: newer.transactions.map((t) =>
          t.reference === "BK-TRANS01" ? { ...t, status: "Cancelled" } : t,
        ),
      });
      await encode(cancelled.id, {}, { "manual:2021-01-01/BK": "bank" });
      const removed = (
        await db.query<any>(
          "select i.id,i.onda_hidden,i.amount_cents::int n,count(a.id)::int assignments from garden_income i left join garden_cash_allocations a on a.income_id=i.id where i.onda_key='tx:BK-TRANS01' group by i.id",
        )
      ).rows[0];
      assert.equal(removed.onda_hidden, true);
      assert.equal(removed.n, 0);
      assert.equal(removed.assignments, 0);
      assert(ids.includes(removed.id));
      await assert.rejects(
        as(admin, () =>
          db.query(
            "select garden_onda_confirm_transactions($1,$2,'{}','{}',true)",
            [admin, randomUUID()],
          ),
        ),
        (e: any) => e.code === "42501",
      );
    },
  );
  await t.test(
    "transaction previews reject stale saves and unknown destinations without partial income/account writes",
    async () => {
      const r = report(
        [tx("BK-UNKNOWN1", "2021-02-01", 50000, { method: "Maya" })],
        [],
        {
          start: "2021-02-01",
          end: "2021-02-01",
          generatedAt: "2021-02-02T04:00:00Z",
        },
      );
      const c = (await context()) as OndaAccountContext,
        plan = buildOndaAccountPreview(r, c),
        id = randomUUID();
      await service(() =>
        db.query(
          "select garden_onda_prepare($1,$2,$3,'Unknown.pdf',1000,$4,$5,$6)",
          [
            admin,
            id,
            createHash("sha256").update(id).digest("hex"),
            JSON.stringify(r),
            JSON.stringify(plan),
            c.fingerprint,
          ],
        ),
      );
      const count = async () =>
        (
          await db.query<any>(
            "select (select count(*)::int from garden_income) income,(select count(*)::int from garden_cash_allocations) allocations",
          )
        ).rows[0];
      const before = await count();
      await assert.rejects(
        service(() =>
          db.query(
            "select garden_onda_confirm_transactions($1,$2,'{}','{}',true)",
            [admin, id],
          ),
        ),
        /Choose an account/,
      );
      assert.deepEqual(await count(), before);
      await db.query(
        "update garden_income set notes=notes||' test edit' where id=(select id from garden_income where onda_key is null and not onda_split limit 1)",
      );
      await assert.rejects(
        service(() =>
          db.query(
            "select garden_onda_confirm_transactions($1,$2,'{}',$3,true)",
            [admin, id, JSON.stringify({ "tx:BK-UNKNOWN1": "bank" })],
          ),
        ),
        /changed after preview/,
      );
      assert.deepEqual(await count(), before);
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
