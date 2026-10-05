import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Effect = { dependencies?: readonly unknown[]; run: () => unknown; cleanup?: () => void };
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  effects: [] as Array<Effect | undefined>,
  pending: [] as number[],
  cursor: 0,
}));
const state = vi.hoisted(() => ({
  session: null as { userId: string; sessionId: string; amr: unknown } | null,
  listener: null as ((event: string) => void) | null,
  getUser: vi.fn(),
  getClaims: vi.fn(),
  updateUser: vi.fn(),
  reauthenticate: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("react", async (original) => ({
  ...(await original<object>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useEffect: (run: () => unknown, dependencies?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.effects[index];
    if (previous && dependencies && previous.dependencies && dependencies.length === previous.dependencies.length
      && dependencies.every((value, offset) => Object.is(value, previous.dependencies![offset]))) return;
    hooks.effects[index] = { run, dependencies, cleanup: previous?.cleanup };
    if (!hooks.pending.includes(index)) hooks.pending.push(index);
  },
}));
vi.mock("@/lib/supabase/client", () => ({
  createSupabaseBrowserClient: () => ({
    auth: {
      getUser: state.getUser,
      getClaims: state.getClaims,
      updateUser: state.updateUser,
      reauthenticate: state.reauthenticate,
      onAuthStateChange: (listener: (event: string) => void) => {
        state.listener = listener;
        return { data: { subscription: { unsubscribe: state.unsubscribe } } };
      },
    },
  }),
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));
vi.mock("./turnstile", () => ({ turnstileEnabled: false, Turnstile: () => null }));

import { ResetPasswordForm } from "./password-forms";

type Element = React.ReactElement<Record<string, unknown>>;
function find(node: React.ReactNode, predicate: (element: Element) => boolean): Element | undefined {
  if (!React.isValidElement(node)) return;
  const element = node as Element;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children as React.ReactNode)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}

function text(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!React.isValidElement(node)) return "";
  return React.Children.toArray((node as Element).props.children as React.ReactNode).map(text).join(" ");
}

function render() {
  hooks.cursor = 0;
  return ResetPasswordForm();
}

function flushEffects() {
  for (const index of hooks.pending.splice(0)) {
    const effect = hooks.effects[index]!;
    effect.cleanup?.();
    const cleanup = effect.run();
    effect.cleanup = typeof cleanup === "function" ? cleanup as () => void : undefined;
  }
}

function cleanupEffects() {
  for (const effect of hooks.effects) effect?.cleanup?.();
  hooks.effects = [];
  hooks.pending = [];
}

async function flushAsync() {
  // The form, session verifier and auth wrapper each have an async boundary.
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function mount() {
  render();
  flushEffects();
  await flushAsync();
  return render();
}

function input(id: string) {
  return find(render(), (element) => element.props.id === id);
}

function enter(id: string, value: string) {
  const field = input(id);
  expect(field, `input ${id}`).toBeDefined();
  (field!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

function submit() {
  const form = find(render(), (element) => element.type === "form")!;
  return (form.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} });
}

function sendCode() {
  const button = find(render(), (element) => element.props.type === "button" && /verification code/.test(text(element)))!;
  expect(button).toBeDefined();
  return (button.props.onClick as () => Promise<void>)();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function claims(userId = "user-a", sessionId = "session-a", amr: unknown = [{ method: "password" }]) {
  return { data: { claims: { sub: userId, session_id: sessionId, amr } }, error: null };
}

beforeEach(() => {
  hooks.values = [];
  hooks.effects = [];
  hooks.pending = [];
  hooks.cursor = 0;
  vi.resetAllMocks();
  vi.useFakeTimers();
  state.session = { userId: "user-a", sessionId: "session-a", amr: [{ method: "password" }] };
  state.listener = null;
  state.getUser.mockImplementation(async () => ({ data: { user: state.session ? { id: state.session.userId } : null }, error: null }));
  state.getClaims.mockImplementation(async () => state.session
    ? claims(state.session.userId, state.session.sessionId, state.session.amr)
    : { data: null, error: null });
  state.updateUser.mockResolvedValue({ error: null });
  state.reauthenticate.mockResolvedValue({ error: null });
  vi.stubGlobal("React", React);
  vi.stubGlobal("window", {
    location: { origin: "https://curvi.ai", href: "/reset-password", search: "?type=recovery" },
    setTimeout,
    clearTimeout,
  });
});

afterEach(() => {
  cleanupEffects();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("password change form", () => {
  it("offers an optional current password, then requires it when the provider requests it", async () => {
    await mount();
    expect(input("current-password")?.props.required).toBe(false);
    expect(input("current-password")?.props.autoComplete).toBe("current-password");
    expect(input("password-code")).toBeUndefined();
    state.updateUser.mockResolvedValueOnce({ error: { code: "current_password_required", message: "private provider details" } });
    enter("new-password", "new-password-for-test");
    await submit();
    expect(state.updateUser).toHaveBeenNthCalledWith(1, { password: "new-password-for-test" });
    expect(input("current-password")?.props.required).toBe(true);
    expect(text(render())).not.toContain("private provider details");
    expect(state.reauthenticate).not.toHaveBeenCalled();

    enter("current-password", "current-password-for-test");
    await submit();
    expect(state.updateUser).toHaveBeenNthCalledWith(2, {
      password: "new-password-for-test", current_password: "current-password-for-test",
    });
    expect(input("new-password")?.props.value).toBe("");
    expect(input("current-password")?.props.value).toBe("");
    expect(text(render())).toContain("Password updated.");
  });

  it.each([
    { label: "object", amr: [{ method: "recovery", timestamp: 1 }] },
    { label: "string", amr: ["recovery"] },
  ])("omits the current password for verified $label recovery claims", async ({ amr }) => {
    state.session!.amr = amr;
    await mount();
    expect(input("current-password")).toBeUndefined();
    enter("new-password", "new-password-for-test");
    await submit();
    expect(state.updateUser).toHaveBeenCalledExactlyOnceWith({ password: "new-password-for-test" });
    expect(state.reauthenticate).not.toHaveBeenCalled();
  });

  it("requests a nonce only after provider demand and sends or resends it only on explicit clicks", async () => {
    await mount();
    enter("new-password", "new-password-for-test");
    enter("current-password", "current-password-for-test");
    state.updateUser.mockResolvedValueOnce({ error: { code: "reauthentication_needed" } });
    await submit();
    expect(input("password-code")?.props.required).toBe(true);
    expect(input("password-code")?.props.autoComplete).toBe("one-time-code");
    expect(state.reauthenticate).not.toHaveBeenCalled();

    await sendCode();
    expect(state.reauthenticate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain("Send a new verification code");
    enter("password-code", " 123456 ");
    state.updateUser.mockResolvedValueOnce({ error: { code: "reauthentication_not_valid" } });
    await submit();
    expect(state.updateUser).toHaveBeenNthCalledWith(2, {
      password: "new-password-for-test", current_password: "current-password-for-test", nonce: "123456",
    });
    expect(input("password-code")?.props.value).toBe("");
    expect(state.reauthenticate).toHaveBeenCalledTimes(1);

    await sendCode();
    expect(state.reauthenticate).toHaveBeenCalledTimes(2);
    enter("password-code", "654321");
    await submit();
    expect(state.updateUser).toHaveBeenNthCalledWith(3, {
      password: "new-password-for-test", current_password: "current-password-for-test", nonce: "654321",
    });
    expect(input("password-code")?.props.value).toBe("");
    expect(text(render())).toContain("Password updated.");
  });

  it("allows an explicit retry when sending a code fails without sending another code automatically", async () => {
    await mount();
    enter("new-password", "new-password-for-test");
    state.updateUser.mockResolvedValueOnce({ error: { code: "reauthentication_needed" } });
    await submit();
    state.reauthenticate.mockRejectedValueOnce(new TypeError("private network details"));
    await sendCode();
    expect(state.reauthenticate).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain("Check your connection and try again.");
    expect(text(render())).not.toContain("private network details");
    await sendCode();
    expect(state.reauthenticate).toHaveBeenCalledTimes(2);
    expect(text(render())).toContain("We sent a verification code");
  });

  it("clears credentials on an account change and ignores an older successful update", async () => {
    await mount();
    enter("new-password", "new-password-for-test");
    enter("current-password", "current-password-for-test");
    state.updateUser.mockResolvedValueOnce({ error: { code: "reauthentication_needed" } });
    await submit();
    enter("password-code", "123456");
    const update = deferred<{ error: null }>();
    state.updateUser.mockReturnValueOnce(update.promise);
    const pending = submit();
    await flushAsync();
    expect(state.updateUser).toHaveBeenCalledTimes(2);

    state.session = { userId: "user-b", sessionId: "session-b", amr: [{ method: "password" }] };
    state.listener!("SIGNED_IN");
    render();
    flushEffects();
    await flushAsync();
    expect(input("new-password")?.props.value).toBe("");
    expect(input("current-password")?.props.value).toBe("");
    expect(input("password-code")).toBeUndefined();
    update.resolve({ error: null });
    await pending;
    expect(text(render())).not.toContain("Password updated.");
    await vi.advanceTimersByTimeAsync(1200);
    expect(window.location.href).toBe("/reset-password");
  });

  it("does not send credentials when sign-out happens during the last session verification", async () => {
    await mount();
    enter("new-password", "new-password-for-test");
    const verification = deferred<ReturnType<typeof claims>>();
    state.getClaims.mockReturnValueOnce(verification.promise);
    const pending = submit();
    await flushAsync();
    expect(state.getClaims).toHaveBeenCalledTimes(2);
    state.session = null;
    state.listener!("SIGNED_OUT");
    render();
    flushEffects();
    await flushAsync();
    verification.resolve(claims());
    await pending;
    expect(state.updateUser).not.toHaveBeenCalled();
    expect(text(render())).toContain("Request a reset link");
    expect(input("new-password")).toBeUndefined();
  });

  it("guards duplicate submissions before rerender and after success", async () => {
    await mount();
    enter("new-password", "new-password-for-test");
    const update = deferred<{ error: null }>();
    state.updateUser.mockReturnValueOnce(update.promise);
    const form = find(render(), (element) => element.type === "form")!;
    const handler = form.props.onSubmit as (event: { preventDefault(): void }) => Promise<void>;
    const first = handler({ preventDefault() {} });
    const second = handler({ preventDefault() {} });
    await flushAsync();
    expect(state.updateUser).toHaveBeenCalledTimes(1);
    expect(find(render(), (element) => element.props.type === "submit")?.props.disabled).toBe(true);
    update.resolve({ error: null });
    await Promise.all([first, second]);
    await handler({ preventDefault() {} });
    expect(state.updateUser).toHaveBeenCalledTimes(1);
    expect(find(render(), (element) => element.props.type === "submit")?.props.disabled).toBe(true);
    expect(input("new-password")?.props.value).toBe("");
    await vi.advanceTimersByTimeAsync(1200);
    expect(window.location.href).toBe("/app");
  });

  it("unsubscribes and prevents a completed update from redirecting after unmount", async () => {
    await mount();
    enter("new-password", "new-password-for-test");
    const update = deferred<{ error: null }>();
    state.updateUser.mockReturnValueOnce(update.promise);
    const pending = submit();
    await flushAsync();
    cleanupEffects();
    expect(state.unsubscribe).toHaveBeenCalledTimes(1);
    update.resolve({ error: null });
    await pending;
    await vi.advanceTimersByTimeAsync(1200);
    expect(window.location.href).toBe("/reset-password");
  });
});
