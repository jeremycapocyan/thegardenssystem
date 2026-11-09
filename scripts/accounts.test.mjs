import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

test("Account administration, restricted admins, and disabled sessions", async (t) => {
  const db = await PGlite.create({ extensions: { btree_gist } });
  const [
    owner,
    viewer,
    finance,
    hr,
    manager,
    employee,
    invited,
    other,
    outsider,
  ] = Array.from({ length: 9 }, () => randomUUID());
  const eid = randomUUID();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  for (const id of [
    owner,
    viewer,
    finance,
    hr,
    manager,
    employee,
    invited,
    other,
    outsider,
  ])
    await db.query("insert into auth.users values($1)", [id]);
  const folder = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await fs.readdir(folder))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(await fs.readFile(new URL(file, folder), "utf8"));
    if (file.includes("gardens_finance"))
      await db.query(
        "insert into garden_profiles(id,display_name,role) values($1,'Jeremy','admin'),($2,'Genesis','viewer')",
        [owner, viewer],
      );
  }
  const as = async (id, fn, role = "authenticated") => {
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
  };
  const assign = (
    actor,
    id,
    role = "admin",
    f = false,
    h = false,
    a = false,
    active = true,
  ) =>
    db.query("select garden_manage_account($1,$2,$3,$4,$5,$6,$7,$8)", [
      actor,
      id,
      "Test account",
      role,
      f,
      h,
      a,
      active,
    ]);
  const command = (id, action, payload) =>
    as(id, () =>
      db.query("select garden_team_command($1,$2::jsonb)", [
        action,
        JSON.stringify(payload),
      ]),
    );
  const rows = (id, table) =>
    as(id, async () => (await db.query(`select * from ${table}`)).rows);
  await t.test(
    "the existing sole admin becomes protected owner; viewers retain finance access",
    async () => {
      const p = (
        await db.query("select * from garden_profiles where id=$1", [owner])
      ).rows[0];
      assert.equal(p.is_owner, true);
      assert.equal(p.manage_accounts, true);
      assert.equal(p.active, true);
      assert.equal(
        (await as(viewer, () => db.query("select garden_is_member() v")))
          .rows[0].v,
        true,
      );
      await assign(owner, finance, "admin", true, false, false);
      await assign(owner, hr, "admin", false, true, false);
      await assign(owner, manager, "admin", false, true, true);
    },
  );
  await t.test(
    "finance-only admin can manage finance, but not private HR or account permissions",
    async () => {
      const category = (
        await db.query(
          "select id from garden_categories where name='Court rental'",
        )
      ).rows[0].id;
      await as(finance, () =>
        db.query(
          "insert into garden_income(business_date,category_id,amount_cents) values('2026-11-01',$1,12345)",
          [category],
        ),
      );
      assert.equal((await rows(finance, "garden_income")).length, 1);
      assert.equal((await rows(finance, "garden_employees")).length, 0);
      await assert.rejects(command(finance, "qr", {}), /manage employee/);
      assert.equal(
        (
          await as(finance, () =>
            db.query("select garden_can_manage_accounts() v"),
          )
        ).rows[0].v,
        false,
      );
      assert.equal(
        (await as(finance, () => db.query("select garden_team_snapshot() v")))
          .rows[0].v.qr,
        null,
      );
      await assert.rejects(
        assign(finance, other, "admin", true),
        /permission required/,
      );
    },
  );
  await t.test(
    "HR-only admin manages attendance and schedules without finance access",
    async () => {
      await command(hr, "employee", {
        id: eid,
        name: "Alex",
        email: "alex@example.invalid",
        started_on: "2020-01-01",
        effective_from: "2020-01-01",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        active: true,
      });
      assert.equal((await rows(hr, "garden_employees")).length, 1);
      assert.equal((await rows(hr, "garden_income")).length, 0);
      assert.equal((await rows(hr, "garden_categories")).length, 0);
      assert.equal(
        (await as(hr, () => db.query("select garden_snapshot() v"))).rows[0].v
          .income.length,
        0,
      );
      await assert.rejects(
        as(hr, () =>
          db.query(
            "insert into garden_categories(kind,name) values('expense','Forbidden')",
          ),
        ),
        (e) => e.code === "42501",
      );
      assert.ok(
        (await as(hr, () => db.query("select garden_team_snapshot() v")))
          .rows[0].v.qr.id,
      );
    },
  );
  await t.test(
    "delegated account managers create restricted admins but cannot exceed their scope",
    async () => {
      await assign(manager, other, "admin", false, true, true);
      assert.equal(
        (
          await db.query("select is_owner from garden_profiles where id=$1", [
            other,
          ])
        ).rows[0].is_owner,
        false,
      );
      await assert.rejects(
        assign(manager, other, "admin", true, true, true),
        /within your own access/,
      );
      await assert.rejects(
        assign(manager, finance, "admin", false, true, false),
        /within your own access/,
      );
      await assert.rejects(
        assign(manager, viewer, "viewer"),
        /within your own access/,
      );
      await assert.rejects(
        assign(hr, other, "admin", false, true),
        /permission required/,
      );
    },
  );
  await t.test(
    "owner and current manager are protected against demotion and self-lockout",
    async () => {
      await assert.rejects(assign(manager, owner, "viewer"), /protected/);
      await assert.rejects(
        assign(owner, owner, "admin", false, false, false, false),
        /protected/,
      );
      await assert.rejects(
        assign(manager, manager, "admin", false, true, false),
        /protected/,
      );
      assert.equal(
        (
          await db.query(
            "select count(*)::int n from garden_profiles where is_owner",
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await t.test(
    "browser users cannot invoke service-only provisioning or spoof an owner actor",
    async () => {
      for (const user of [owner, manager, employee, outsider]) {
        await assert.rejects(
          as(user, () => assign(owner, invited, "admin", true, true, true)),
          (e) => e.code === "42501",
        );
        await assert.rejects(
          as(user, () =>
            db.query("select garden_provision_employee($1,$2,$3)", [
              owner,
              eid,
              employee,
            ]),
          ),
          (e) => e.code === "42501",
        );
      }
      await assert.rejects(
        as("", () => assign(owner, invited, "admin", true, true, true), "anon"),
        (e) => e.code === "42501",
      );
    },
  );
  await t.test(
    "account manager can link a registered employee without granting management rights",
    async () => {
      await db.query("select garden_provision_employee($1,$2,$3)", [
        manager,
        eid,
        employee,
      ]);
      const p = (
        await db.query("select * from garden_profiles where id=$1", [employee])
      ).rows[0];
      assert.equal(p.role, "employee");
      assert.equal(p.finance_access, false);
      assert.equal(p.team_access, false);
      assert.equal(p.manage_accounts, false);
      assert.equal((await rows(employee, "garden_employees")).length, 1);
      assert.equal((await rows(employee, "garden_income")).length, 0);
      await assert.rejects(
        assign(owner, employee, "admin", true, true, true),
        /cannot be converted/,
      );
      await assert.rejects(
        db.query("select garden_provision_employee($1,$2,$3)", [
          owner,
          eid,
          viewer,
        ]),
        /administrator, viewer/,
      );
    },
  );
  await t.test(
    "suspending employee access blocks existing-token reads and clock/request mutations",
    async () => {
      await assign(manager, employee, "employee", false, false, false, false);
      assert.equal((await rows(employee, "garden_employees")).length, 0);
      await assert.rejects(
        command(employee, "request", {
          id: randomUUID(),
          kind: "advance",
          amount_cents: 100,
          reason: "Test",
        }),
        /Sign in first/,
      );
      await assert.rejects(
        command(employee, "clock_in", { id: randomUUID(), qr: randomUUID() }),
        /Sign in first/,
      );
      await assert.rejects(
        db.query("select garden_provision_employee($1,$2,$3)", [
          owner,
          eid,
          employee,
        ]),
        /disabled employee/,
      );
      await assign(manager, employee, "employee", false, false, false, true);
      assert.equal((await rows(employee, "garden_employees")).length, 1);
    },
  );
  await t.test(
    "suspending a finance administrator immediately revokes all database reads and writes",
    async () => {
      await assign(owner, finance, "admin", true, false, false, false);
      assert.equal((await rows(finance, "garden_income")).length, 0);
      assert.equal((await rows(finance, "garden_audit")).length, 0);
      await assert.rejects(
        as(finance, () =>
          db.query(
            "insert into garden_categories(kind,name) values('expense','Forbidden')",
          ),
        ),
        (e) => e.code === "42501",
      );
      await assign(owner, finance, "admin", true, false, false, true);
      assert.equal((await rows(finance, "garden_income")).length, 1);
    },
  );
  await t.test(
    "disabled or revoked account managers cannot use a stale service request",
    async () => {
      await assign(owner, manager, "admin", false, true, true, false);
      await assert.rejects(
        assign(manager, other, "admin", false, true),
        /permission required/,
      );
      await assert.rejects(
        db.query("select garden_provision_employee($1,$2,$3)", [
          manager,
          eid,
          employee,
        ]),
        /permission required/,
      );
      await assign(owner, manager, "admin", false, true, false, true);
      await assert.rejects(
        assign(manager, other, "admin", false, true),
        /permission required/,
      );
    },
  );
  await t.test(
    "finance and employee roles cannot discover HR audit details or other profiles",
    async () => {
      assert.ok(
        (await rows(hr, "garden_audit")).some(
          (a) => a.table_name === "garden_employees",
        ),
      );
      assert.ok(
        !(await rows(finance, "garden_audit")).some(
          (a) =>
            a.table_name === "garden_employees" ||
            a.table_name === "garden_profiles",
        ),
      );
      assert.equal((await rows(employee, "garden_profiles")).length, 1);
      assert.equal((await rows(finance, "garden_profiles")).length, 1);
      assert.equal((await rows(viewer, "garden_audit")).length, 0);
      const audits = (
        await db.query(
          "select actor_id from garden_audit where table_name='garden_profiles' and record_id=$1 order by id desc limit 1",
          [finance],
        )
      ).rows;
      assert.equal(audits[0].actor_id, owner);
    },
  );
  await t.test(
    "null, unsupported roles, and permissionless admins are rejected; direct profile edits cannot escalate",
    async () => {
      await assert.rejects(assign(owner, other, "admin"), /at least one/);
      await assert.rejects(
        assign(owner, other, "owner", true, true, true),
        /Invalid account/,
      );
      await assert.rejects(
        assign(owner, other, "admin", null, true, true),
        /Invalid account/,
      );
      await assert.rejects(
        as(employee, () =>
          db.query(
            "update garden_profiles set role='admin',is_owner=true where id=$1",
            [employee],
          ),
        ),
        (e) => e.code === "42501",
      );
      assert.equal(
        (
          await db.query("select role from garden_profiles where id=$1", [
            employee,
          ])
        ).rows[0].role,
        "employee",
      );
    },
  );
  await db.close();
});
