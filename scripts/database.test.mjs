import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

test("PostgreSQL migration, permissions, and record invariants", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } });
  const admin = "11111111-1111-4111-8111-111111111111";
  const viewer = "22222222-2222-4222-8222-222222222222";
  const outsider = "33333333-3333-4333-8333-333333333333";
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
    insert into auth.users values('${admin}'),('${viewer}'),('${outsider}');`);
  const folder = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await fs.readdir(folder))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await db.exec(await fs.readFile(new URL(name, folder), "utf8"));
  await db.query(
    "insert into public.garden_profiles(id,display_name,role) values($1,$2,$3),($4,$5,$6)",
    [admin, "Jeremy", "admin", viewer, "Genesis", "viewer"],
  );
  const categories = (
    await db.query("select id,kind,name from public.garden_categories")
  ).rows;
  const income = categories.find((c) => c.name === "Court rental").id;
  const rent = categories.find((c) => c.name === "Rent").id;
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
  const incomeId = "44444444-4444-4444-8444-444444444444";
  const billId = "55555555-5555-4555-8555-555555555555";
  const termId = "66666666-6666-4666-8666-666666666666";
  const revisionId = "77777777-7777-4777-8777-777777777777";
  const payload = {
    bill_id: billId,
    term_id: termId,
    code: "RENT-001",
    name: "Court rent",
    category_id: rent,
    start_month: "2026-11-01",
    end_month: null,
    amount_cents: 2500000,
    due_day: 30,
    notes: "",
  };
  await t.test(
    "anonymous visitors cannot read records or call the snapshot",
    async () => {
      await as(
        "",
        async () => {
          await assert.rejects(
            db.query("select * from public.garden_income"),
            (e) => e.code === "42501",
          );
          await assert.rejects(
            db.query("select public.garden_snapshot()"),
            (e) => e.code === "42501",
          );
        },
        "anon",
      );
    },
  );
  await t.test("Jeremy can write income; server stamps its actor", async () => {
    await as(admin, async () => {
      await db.query(
        "insert into public.garden_income(id,business_date,category_id,amount_cents,notes,created_by) values($1,$2,$3,$4,$5,$6)",
        [incomeId, "2026-11-01", income, 100000, "Daily total", viewer],
      );
    });
    const row = (
      await db.query(
        "select created_by from public.garden_income where id=$1",
        [incomeId],
      )
    ).rows[0];
    assert.equal(row.created_by, admin);
  });
  await t.test(
    "viewers can read shared records but cannot insert, update, or delete",
    async () => {
      await as(viewer, async () => {
        assert.equal(
          (await db.query("select * from public.garden_income")).rows.length,
          1,
        );
        await assert.rejects(
          db.query(
            "insert into public.garden_income(business_date,category_id,amount_cents) values($1,$2,$3)",
            ["2026-11-02", income, 200000],
          ),
          (e) => e.code === "42501",
        );
        assert.equal(
          (
            await db.query(
              "update public.garden_income set amount_cents=1 where id=$1 returning id",
              [incomeId],
            )
          ).rows.length,
          0,
        );
        assert.equal(
          (
            await db.query(
              "delete from public.garden_income where id=$1 returning id",
              [incomeId],
            )
          ).rows.length,
          0,
        );
      });
    },
  );
  await t.test(
    "a viewer cannot promote their own profile or invoke bill mutations",
    async () => {
      await as(viewer, async () => {
        await assert.rejects(
          db.query(
            "update public.garden_profiles set role='admin' where id=$1",
            [viewer],
          ),
          (e) => e.code === "42501",
        );
        await assert.rejects(
          db.query("select public.garden_save_bill($1::jsonb,$2)", [
            JSON.stringify(payload),
            billId,
          ]),
          (e) => e.code === "42501",
        );
      });
    },
  );
  await t.test("authenticated nonmembers have no financial data", async () => {
    await as(outsider, async () => {
      const row = (await db.query("select public.garden_snapshot() as data"))
        .rows[0];
      assert.equal(row.data.income.length, 0);
      assert.equal(row.data.categories.length, 0);
      assert.equal(
        (await db.query("select * from public.garden_profiles")).rows.length,
        0,
      );
    });
  });
  await t.test(
    "duplicate daily income and expense-category income are rejected",
    async () => {
      await as(admin, async () => {
        await assert.rejects(
          db.query(
            "insert into public.garden_income(business_date,category_id,amount_cents) values($1,$2,$3)",
            ["2026-11-01", income, 100],
          ),
          (e) => e.code === "23505",
        );
        await assert.rejects(
          db.query(
            "insert into public.garden_income(business_date,category_id,amount_cents) values($1,$2,$3)",
            ["2026-11-02", rent, 100],
          ),
          (e) => e.code === "23514",
        );
      });
    },
  );
  await t.test(
    "a fixed bill and its initial terms are saved atomically",
    async () => {
      await as(admin, async () => {
        await db.query("select public.garden_save_bill($1::jsonb,$2)", [
          JSON.stringify(payload),
          billId,
        ]);
      });
      assert.equal(
        (await db.query("select * from public.garden_fixed_bills")).rows.length,
        1,
      );
      assert.equal(
        (await db.query("select * from public.garden_bill_terms")).rows.length,
        1,
      );
    },
  );
  await t.test(
    "overlapping versions and non-month-start dates are rejected",
    async () => {
      await as(admin, async () => {
        await assert.rejects(
          db.query(
            "insert into public.garden_bill_terms(bill_id,start_month,amount_cents,due_day)values($1,$2,$3,$4)",
            [billId, "2026-12-01", 3000000, 30],
          ),
          (e) => e.code === "23P01",
        );
        await assert.rejects(
          db.query(
            "insert into public.garden_bill_terms(bill_id,start_month,amount_cents,due_day)values($1,$2,$3,$4)",
            [billId, "2026-12-30", 3000000, 30],
          ),
          (e) => e.code === "23514",
        );
      });
    },
  );
  await t.test("changing monthly terms preserves prior months", async () => {
    await as(admin, async () => {
      await db.query("select public.garden_revise_bill($1::jsonb,$2)", [
        JSON.stringify({
          ...payload,
          term_id: revisionId,
          start_month: "2026-12-01",
          amount_cents: 2600000,
        }),
        billId,
      ]);
    });
    const terms = (
      await db.query(
        "select start_month::text,end_month::text,amount_cents::int from public.garden_bill_terms order by start_month",
      )
    ).rows;
    assert.deepEqual(terms, [
      {
        start_month: "2026-11-01",
        end_month: "2026-11-01",
        amount_cents: 2500000,
      },
      { start_month: "2026-12-01", end_month: null, amount_cents: 2600000 },
    ]);
  });
  await t.test(
    "failed revisions roll back their closing of previous terms",
    async () => {
      await as(admin, async () => {
        await assert.rejects(
          db.query("select public.garden_revise_bill($1::jsonb,$2)", [
            JSON.stringify({
              ...payload,
              term_id: "88888888-8888-4888-8888-888888888888",
              start_month: "2027-01-01",
              due_day: 35,
            }),
            billId,
          ]),
          (e) => e.code === "23514",
        );
      });
      assert.equal(
        (
          await db.query(
            "select end_month from public.garden_bill_terms where id=$1",
            [revisionId],
          )
        ).rows[0].end_month,
        null,
      );
    },
  );
  await t.test(
    "payments require a matching obligation, type, and due month",
    async () => {
      await as(admin, async () => {
        await db.query(
          "insert into public.garden_expenses(paid_on,category_id,payment_kind,fixed_bill_id,due_month,amount_cents)values($1,$2,$3,$4,$5,$6)",
          ["2026-12-02", rent, "fixed", billId, "2026-11-01", 2500000],
        );
        await assert.rejects(
          db.query(
            "insert into public.garden_expenses(paid_on,category_id,payment_kind,fixed_bill_id,due_month,amount_cents)values($1,$2,$3,$4,$5,$6)",
            ["2026-12-02", rent, "fixed", billId, "2026-10-01", 2500000],
          ),
          (e) => e.code === "23514",
        );
        await assert.rejects(
          db.query(
            "insert into public.garden_expenses(paid_on,category_id,payment_kind,amount_cents)values($1,$2,$3,$4)",
            ["2026-11-01", rent, "fixed", 100],
          ),
          (e) => e.code === "23514",
        );
        await assert.rejects(
          db.query(
            "insert into public.garden_expenses(paid_on,category_id,payment_kind,amount_cents)values($1,$2,$3,$4)",
            ["2026-11-01", rent, "operating", -100],
          ),
          (e) => e.code === "23514",
        );
      });
    },
  );
  await t.test("bills with payments cannot be deleted", async () => {
    await as(admin, async () => {
      await assert.rejects(
        db.query("delete from public.garden_fixed_bills where id=$1", [billId]),
        (e) => e.code === "23503",
      );
    });
  });
  await t.test(
    "audit events are written by the server, and viewers cannot read or erase them",
    async () => {
      assert.ok(
        (
          await db.query(
            "select * from public.garden_audit where actor_id=$1",
            [admin],
          )
        ).rows.length > 0,
      );
      await as(viewer, async () => {
        assert.equal(
          (await db.query("select * from public.garden_audit")).rows.length,
          0,
        );
        await assert.rejects(
          db.query("delete from public.garden_audit"),
          (e) => e.code === "42501",
        );
      });
    },
  );
  await t.test(
    "snapshots include more than the usual 1,000-row API limit",
    async () => {
      await as(admin, async () => {
        await db.query(
          "insert into public.garden_income(business_date,category_id,amount_cents)select date '2020-01-01'+n,$1,100 from generate_series(0,1004)n",
          [income],
        );
        const data = (await db.query("select public.garden_snapshot() as data"))
          .rows[0].data;
        assert.equal(data.income.length, 1006);
      });
    },
  );
  await db.close();
});
