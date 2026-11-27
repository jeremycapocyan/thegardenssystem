import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { POST as preview } from "../src/app/api/finance/imports/onda/preview/route";
import { POST as confirm } from "../src/app/api/finance/imports/onda/[id]/confirm/route";
import { POST as refresh } from "../src/app/api/finance/imports/onda/[id]/refresh/route";
import { GET as pdf } from "../src/app/api/finance/imports/onda/[id]/pdf/route";
import { GET as history } from "../src/app/api/finance/imports/onda/route";
import { fixturePdf, report, tx } from "./onda-fixtures";
test("Onda HTTP endpoints verify finance permissions and trust only server-parsed data", async (t) => {
  const ids = {
    admin: randomUUID(),
    viewer: randomUUID(),
    hr: randomUUID(),
    employee: randomUUID(),
    disabled: randomUUID(),
    accounts: randomUUID(),
  };
  const profiles = Object.fromEntries(
    Object.entries(ids).map(([kind, id]) => [
      id,
      {
        id,
        display_name: "Fictional " + kind,
        role:
          kind === "viewer"
            ? "viewer"
            : kind === "employee"
              ? "employee"
              : "admin",
        active: kind !== "disabled",
        finance_access: ["admin", "viewer", "disabled"].includes(kind),
        team_access: kind === "hr",
        manage_accounts: kind === "accounts",
        is_owner: false,
      },
    ]),
  );
  let stored: Record<string, unknown> | null = null,
    confirmedArgs: Record<string, unknown> | null = null,
    prepareArgs: Record<string, unknown> | null = null,
    storageUploads = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const path = req.url || "";
    let text = "";
    for await (const chunk of req) text += chunk.toString();
    const send = (v: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(v));
    };
    if (path.startsWith("/auth/v1/user")) {
      const uid = String(req.headers.authorization || "").replace(
        "Bearer ",
        "",
      );
      if (!(uid in profiles))
        return send({ message: "Unknown fixture account" }, 401);
      return send({
        id: uid,
        aud: "authenticated",
        role: "authenticated",
        email: "fixture@example.invalid",
      });
    }
    if (path.startsWith("/rest/v1/garden_profiles")) {
      const id =
        new URL("http://localhost" + path).searchParams.get("id")?.slice(3) ||
        "";
      return send(profiles[id] || null);
    }
    if (path.startsWith("/rest/v1/garden_onda_imports")) {
      if (path.includes("sha256=")) return send([]);
      if (path.includes("id=eq.")) return send(stored ? [stored] : []);
      return send([]);
    }
    if (path === "/rest/v1/rpc/garden_onda_context")
      return send({
        fingerprint: "fixture-state",
        income: [],
        expenses: [],
        allocations: [],
        settings: { start_date: "2020-11-01", cash: 0, bank: 0, booking: 0 },
        entries: [],
        transactions: [],
        refunds: [],
        days: [],
        links: [],
        categories: [
          {
            id: randomUUID(),
            kind: "income",
            name: "Court rental",
            active: true,
          },
          { id: randomUUID(), kind: "income", name: "Open play", active: true },
        ],
      });
    if (path.startsWith("/storage/v1/object/")) {
      storageUploads++;
      return send({ Key: "fixture.pdf", Id: randomUUID() });
    }
    if (path === "/rest/v1/rpc/garden_onda_prepare") {
      prepareArgs = JSON.parse(text);
      const b = prepareArgs!;
      stored = {
        id: b.p_id,
        sha256: b.p_hash,
        filename: b.p_name,
        file_bytes: b.p_bytes,
        actor_id: b.p_actor,
        parsed: b.p_parsed,
        plan: b.p_plan,
        snapshot_hash: b.p_snapshot,
        state: "preview",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1800000).toISOString(),
        result: null,
      };
      return send(stored);
    }
    if (path === "/rest/v1/rpc/garden_onda_confirm_transactions") {
      confirmedArgs = JSON.parse(text);
      return send({
        import_id: confirmedArgs!.p_id,
        inserted: 1,
        updated: 0,
        unchanged: 0,
        change_cents: 90000,
        source_net_cents: 90000,
      });
    }
    return send({ message: "Unknown fixture endpoint" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const previous = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    secret: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fictional-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fictional-server-key";
  const id = randomUUID(),
    params = { params: Promise.resolve({ id }) };
  const request = (method: string, token?: string, body?: BodyInit) =>
    new Request("http://localhost/api/finance/imports/onda/", {
      method,
      headers: token ? { Authorization: "Bearer " + token } : {},
      body,
    });
  try {
    await t.test(
      "unauthenticated requests cannot preview, confirm, refresh, download or list",
      async () => {
        assert.equal((await preview(request("POST"))).status, 401);
        assert.equal((await confirm(request("POST"), params)).status, 401);
        assert.equal((await refresh(request("POST"), params)).status, 401);
        assert.equal((await pdf(request("GET"), params)).status, 401);
        assert.equal((await history(request("GET"))).status, 401);
      },
    );
    await t.test(
      "viewers, employees, HR-only, account-only and disabled users are denied every endpoint",
      async () => {
        for (const token of [
          ids.viewer,
          ids.employee,
          ids.hr,
          ids.accounts,
          ids.disabled,
        ]) {
          assert.equal((await preview(request("POST", token))).status, 403);
          assert.equal(
            (await confirm(request("POST", token), params)).status,
            403,
          );
          assert.equal(
            (await refresh(request("POST", token), params)).status,
            403,
          );
          assert.equal((await pdf(request("GET", token), params)).status, 403);
          assert.equal((await history(request("GET", token))).status, 403);
        }
        assert.equal(storageUploads, 0);
      },
    );
    await t.test(
      "finance admin uploads and previews a PDF without confirming income",
      async () => {
        const f = new FormData();
        f.set("id", id);
        f.set(
          "file",
          new File(
            [
              new Uint8Array(
                await fixturePdf(
                  report([tx("BK-SAFEAPI", "2020-11-01", 90000)]),
                ),
              ).buffer,
            ],
            "Fictional Onda.pdf",
            { type: "application/pdf" },
          ),
        );
        const r = await preview(request("POST", ids.admin, f));
        const b = await r.json();
        assert.equal(r.status, 200, JSON.stringify(b));
        assert.equal(b.state, "preview");
        assert.equal(b.preview.report.net, 90000);
        assert.equal(b.preview.encoding_version, 2);
        assert.equal(b.preview.entries[0].account, "booking");
        assert.equal(storageUploads, 1);
        assert.equal(confirmedArgs, null);
        assert.equal(prepareArgs!.p_actor, ids.admin);
        assert(!JSON.stringify(prepareArgs).includes("Sample guest"));
      },
    );
    await t.test(
      "confirmation ignores client-supplied actor and transaction totals",
      async () => {
        const r = await confirm(
          request(
            "POST",
            ids.admin,
            JSON.stringify({
              actor_id: ids.employee,
              source_amount: 1,
              transactions: [],
              resolutions: {},
            }),
          ),
          params,
        );
        const b = await r.json();
        assert.equal(r.status, 200, JSON.stringify(b));
        assert.equal(b.source_net_cents, 90000);
        assert.equal(confirmedArgs!.p_actor, ids.admin);
        assert.deepEqual(Object.keys(confirmedArgs!).sort(), [
          "p_accounts",
          "p_actor",
          "p_id",
          "p_replace_allocations",
          "p_resolutions",
        ]);
        assert.deepEqual(confirmedArgs!.p_accounts, {});
        assert.equal(confirmedArgs!.p_replace_allocations, false);
        assert.equal(r.headers.get("cache-control"), "no-store");
      },
    );
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = previous.url;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = previous.key;
    process.env.SUPABASE_SERVICE_ROLE_KEY = previous.secret;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  }
});
