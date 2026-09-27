import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBreakerStore } from "./breaker";

function setup() {
  const clock = { ms: 0 };
  const store = new InMemoryBreakerStore(() => clock.ms);
  const breaker = new CircuitBreaker(store);
  return { clock, breaker };
}

describe("CircuitBreaker", () => {
  it("stays closed below the failure threshold", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 4; i++) await breaker.recordFailure("p");
    expect(await breaker.isOpen("p")).toBe(false);
  });

  it("opens after 5 failures within the 60s window", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 5; i++) await breaker.recordFailure("p");
    expect(await breaker.isOpen("p")).toBe(true);
  });

  it("does not open when failures fall outside the window", async () => {
    const { clock, breaker } = setup();
    for (let i = 0; i < 4; i++) await breaker.recordFailure("p");
    clock.ms += 61_000;
    for (let i = 0; i < 4; i++) await breaker.recordFailure("p");
    expect(await breaker.isOpen("p")).toBe(false);
    await breaker.recordFailure("p");
    expect(await breaker.isOpen("p")).toBe(true);
  });

  it("closes again after openSeconds", async () => {
    const { clock, breaker } = setup();
    for (let i = 0; i < 5; i++) await breaker.recordFailure("p");
    clock.ms += 119_000;
    expect(await breaker.isOpen("p")).toBe(true);
    clock.ms += 2_000;
    expect(await breaker.isOpen("p")).toBe(false);
  });

  it("resets the failure count on success", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 4; i++) await breaker.recordFailure("p");
    await breaker.recordSuccess("p");
    for (let i = 0; i < 4; i++) await breaker.recordFailure("p");
    expect(await breaker.isOpen("p")).toBe(false);
  });

  it("tracks providers independently", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 5; i++) await breaker.recordFailure("p1");
    expect(await breaker.isOpen("p1")).toBe(true);
    expect(await breaker.isOpen("p2")).toBe(false);
  });

  it("honors custom options", async () => {
    const clock = { ms: 0 };
    const store = new InMemoryBreakerStore(() => clock.ms);
    const breaker = new CircuitBreaker(store, { failureThreshold: 2, openSeconds: 10 });
    await breaker.recordFailure("p");
    expect(await breaker.isOpen("p")).toBe(false);
    await breaker.recordFailure("p");
    expect(await breaker.isOpen("p")).toBe(true);
    clock.ms += 11_000;
    expect(await breaker.isOpen("p")).toBe(false);
  });
});
