import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_STATUS_TTL_MS,
  fetchAcquisitionState,
  parseStatusBody,
  resetClientAcquisitionForTests,
  STATUS_PATH,
} from "./acquisition-client";

// The browser side of the gate (P18-03): one shared status call, and any
// failure reads as open so the signup links never disappear by mistake.

afterEach(() => resetClientAcquisitionForTests());

function answering(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch & {
    mock: { calls: unknown[][] };
  };
}

describe("parseStatusBody", () => {
  it("reads only an explicit waitlist as closed", () => {
    expect(parseStatusBody({ acquisition: "waitlist" })).toBe("waitlist");
    for (const body of [{ acquisition: "open" }, null, {}, { acquisition: "WAITLIST" }, "waitlist"]) {
      expect(parseStatusBody(body)).toBe("open");
    }
  });
});

describe("fetchAcquisitionState", () => {
  it("asks /api/status once per minute and shares the answer", async () => {
    let clock = 0;
    const fetchImpl = answering({ acquisition: "waitlist" });
    expect(await fetchAcquisitionState(fetchImpl, () => clock)).toBe("waitlist");
    clock += CLIENT_STATUS_TTL_MS - 1;
    expect(await fetchAcquisitionState(fetchImpl, () => clock)).toBe("waitlist");
    expect(fetchImpl.mock.calls).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(STATUS_PATH);
    clock += 2;
    await fetchAcquisitionState(fetchImpl, () => clock);
    expect(fetchImpl.mock.calls).toHaveLength(2);
  });

  it("reads an error answer or a network failure as open", async () => {
    expect(await fetchAcquisitionState(answering({ acquisition: "waitlist" }, 500))).toBe("open");
    resetClientAcquisitionForTests();
    const failing = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await fetchAcquisitionState(failing)).toBe("open");
  });
});
