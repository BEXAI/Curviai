import { describe, expect, it, vi } from "vitest";
import { watchSignedIn, type AuthSessionSource } from "./signed-in";

function fakeClient(session: Promise<unknown>) {
  let listener: ((event: string, session: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  const client: AuthSessionSource = {
    auth: {
      getSession: () => session.then((value) => ({ data: { session: value } })),
      onAuthStateChange: (callback) => {
        listener = callback;
        return { data: { subscription: { unsubscribe } } };
      },
    },
  };
  return {
    client,
    unsubscribe,
    emit: (event: string, value: unknown) => listener?.(event, value),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("watchSignedIn", () => {
  it("keeps visitors signed out when Supabase is not configured", () => {
    const onChange = vi.fn();
    const stop = watchSignedIn(null, onChange);
    stop();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports an existing session as signed in", async () => {
    const onChange = vi.fn();
    watchSignedIn(fakeClient(Promise.resolve({ user: { id: "u1" } })).client, onChange);
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("reports no session as signed out", async () => {
    const onChange = vi.fn();
    watchSignedIn(fakeClient(Promise.resolve(null)).client, onChange);
    await flush();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("follows sign in and sign out after the first read", async () => {
    const onChange = vi.fn();
    const fake = fakeClient(Promise.resolve(null));
    watchSignedIn(fake.client, onChange);
    await flush();
    fake.emit("SIGNED_IN", { user: { id: "u1" } });
    expect(onChange).toHaveBeenLastCalledWith(true);
    fake.emit("SIGNED_OUT", null);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("stays signed out when the session read fails", async () => {
    const onChange = vi.fn();
    watchSignedIn(fakeClient(Promise.reject(new Error("storage blocked"))).client, onChange);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops listening once stopped", async () => {
    const onChange = vi.fn();
    const fake = fakeClient(Promise.resolve({ user: { id: "u1" } }));
    const stop = watchSignedIn(fake.client, onChange);
    stop();
    await flush();
    fake.emit("SIGNED_IN", { user: { id: "u1" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
