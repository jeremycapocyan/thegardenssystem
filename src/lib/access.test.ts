import test from "node:test";
import assert from "node:assert/strict";
import { canManage, canViewFinance, accountInput } from "./access";
import type { Profile } from "./types";
test("client permissions mirror restricted admin scopes and active status", () => {
  const p: Profile = {
    id: "test",
    display_name: "Test",
    role: "admin",
    active: true,
    finance_access: false,
    team_access: true,
    manage_accounts: false,
  };
  assert.equal(canManage(p, "finance"), false);
  assert.equal(canManage(p, "team"), true);
  assert.equal(canManage(p, "accounts"), false);
  assert.equal(canViewFinance(p), false);
  assert.equal(canManage({ ...p, is_owner: true }, "accounts"), true);
  assert.equal(
    canManage({ ...p, is_owner: true, active: false }, "team"),
    false,
  );
  assert.equal(
    canManage({ ...p, role: "employee", manage_accounts: true }, "accounts"),
    false,
  );
  assert.equal(canViewFinance({ ...p, role: "viewer" }), true);
});
test("account creation accepts explicit restrictions and rejects malformed or elevated roles", () => {
  const v = {
    display_name: " Staff manager ",
    email: " TEST@example.invalid ",
    role: "admin",
    finance_access: false,
    team_access: true,
    manage_accounts: true,
    active: true,
  };
  assert.equal(accountInput(v).email, "test@example.invalid");
  assert.equal(accountInput(v).display_name, "Staff manager");
  assert.throws(() => accountInput({ ...v, role: "owner" }));
  assert.throws(() => accountInput({ ...v, manage_accounts: "true" }));
  assert.throws(() =>
    accountInput({
      ...v,
      finance_access: false,
      team_access: false,
      manage_accounts: false,
    }),
  );
  assert.throws(() => accountInput({ ...v, email: "invalid" }));
  assert.deepEqual(accountInput({ ...v, role: "viewer" }), {
    display_name: "Staff manager",
    email: "test@example.invalid",
    role: "viewer",
    finance_access: true,
    team_access: false,
    manage_accounts: false,
    active: true,
  });
});
