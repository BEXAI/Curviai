import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ dbMode: true, user: { id: "verified-user" } as { id: string } | null, reason: "disposable_email" as string | null, read: vi.fn() }));
vi.mock("@/lib/services", () => ({ isDbMode: () => state.dbMode }));
vi.mock("@/lib/supabase/server", () => ({ getSessionUser: async () => state.user }));
vi.mock("@/lib/services/db", () => ({ getDb: () => ({ query: { signupGrants: { findFirst: state.read } } }) }));
import { SignupGrantNotice } from "./signup-grant-notice";
beforeEach(() => { (globalThis as { React?: typeof React }).React = React; state.dbMode = true; state.user = { id: "verified-user" }; state.reason = "disposable_email"; state.read.mockReset().mockImplementation(async () => ({ withheldReason: state.reason })); });
describe("signup grant notice", () => {
  it("shows the temporary-inbox message only for the current user's withheld grant", async () => {
    const notice = await SignupGrantNotice();
    expect(renderToStaticMarkup(notice)).toContain("Temporary inboxes cannot receive free credits");
    const where = state.read.mock.calls[0][0].where;
    const equal = vi.fn();
    where({ userId: "user_column" }, { eq: equal });
    expect(equal).toHaveBeenCalledWith("user_column", "verified-user");
    state.reason = null;
    expect(await SignupGrantNotice()).toBeNull();
  });
  it("does no grant lookup in demo mode or without a session and handles lookup failure", async () => {
    state.dbMode = false;
    expect(await SignupGrantNotice()).toBeNull();
    state.dbMode = true; state.user = null;
    expect(await SignupGrantNotice()).toBeNull();
    expect(state.read).not.toHaveBeenCalled();
    state.user = { id: "verified-user" }; state.read.mockRejectedValueOnce(new Error("offline"));
    expect(await SignupGrantNotice()).toBeNull();
  });
});
