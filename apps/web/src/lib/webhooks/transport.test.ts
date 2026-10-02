import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createWebhookTransport, publicAddress, webhookUrl, type Requester, type Resolver } from "./transport";

const publicDns: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
function fixtureResponse(status: number, chunks: string[], headers: Record<string, string> = {}, neverEnd = false) {
  let options: RequestOptions | undefined;
  const send: Requester = (received, callback) => {
    options = received;
    const req = new EventEmitter() as ClientRequest;
    req.destroy = vi.fn(() => req);
    req.end = vi.fn(() => {
      queueMicrotask(() => {
        const socket = new EventEmitter(); req.emit("socket", socket); socket.emit("secureConnect");
        const response = new PassThrough() as unknown as IncomingMessage;
        response.statusCode = status; response.headers = headers;
        callback(response);
        for (const chunk of chunks) (response as unknown as PassThrough).write(chunk);
        if (!neverEnd) (response as unknown as PassThrough).end();
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  };
  return { send, options: () => options };
}
describe("public pinned HTTPS webhook transport", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.100.100.200", "172.20.0.1", "192.168.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "fd00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::", "2001::1", "3fff::1", "0x7f000001"]) ("blocks special address %s", address => expect(publicAddress(address)).toBe(false));
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) ("allows public address %s", address => expect(publicAddress(address)).toBe(true));
  it.each(["http://example.com/hook", "https://user:pass@example.com/hook", "https://example.com:8443/hook", "https://example.com/?token=secret", "https://example.com/#x", "https://127.0.0.1/hook", "https://[::1]/hook", "https://localhost/hook", "https://example.com./hook"]) ("rejects unsafe destination %s", url => expect(() => webhookUrl(url)).toThrow("unsafe_destination"));
  it("rejects a mixed public/private answer and validates again for a DNS rebinding attempt", async () => {
    const request = vi.fn<Requester>();
    const mixed = createWebhookTransport({ resolve: async () => [...await publicDns("host"), { address: "10.0.0.1", family: 4 }], request });
    await expect(mixed("https://example.com/hook", "{}", {})).rejects.toThrow("unsafe_destination");
    expect(request).not.toHaveBeenCalled();
    const fixture = fixtureResponse(204, []);
    const resolver = vi.fn<Resolver>().mockResolvedValueOnce(await publicDns("host")).mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const send = createWebhookTransport({ resolve: resolver, request: fixture.send });
    await expect(send("https://example.com/hook", "{}", {})).resolves.toEqual({ statusCode: 204 });
    await expect(send("https://example.com/hook", "{}", {})).rejects.toThrow("unsafe_destination");
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(fixture.options()).toMatchObject({ hostname: "example.com", servername: "example.com", agent: false, family: 4, autoSelectFamily: false, rejectUnauthorized: true });
    const callback = vi.fn();
    (fixture.options()!.lookup as (...args: unknown[]) => void)("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });
  it("matches the actual Node HTTPS lookup contract without opening any socket", async () => {
    let actualAll: boolean | undefined;
    const send = createWebhookTransport({ resolve: publicDns, request: (options, callback) => httpsRequest({ ...options, lookup: (_hostname, lookupOptions, done) => {
      actualAll = lookupOptions.all;
      done(new Error("fixture prevents connection"), "", 4);
    } }, callback) });
    await expect(send("https://fixture.invalid/hook", "{}", {})).rejects.toThrow("network_failed");
    expect(actualAll).not.toBe(true);
  });
  it("refuses redirects and bounds response bytes and slow or stalled DNS/receivers", async () => {
    const redirect = fixtureResponse(302, [], { location: "https://127.0.0.1/" });
    await expect(createWebhookTransport({ resolve: publicDns, request: redirect.send })("https://example.com/hook", "{}", {})).rejects.toThrow("redirect_refused");
    const large = fixtureResponse(200, ["x".repeat(4097)]);
    await expect(createWebhookTransport({ resolve: publicDns, request: large.send })("https://example.com/hook", "{}", {})).rejects.toThrow("response_too_large");
    const declared = fixtureResponse(200, [], { "content-length": "100000" });
    await expect(createWebhookTransport({ resolve: publicDns, request: declared.send })("https://example.com/hook", "{}", {})).rejects.toThrow("response_too_large");
    const slow = fixtureResponse(200, ["x"], {}, true);
    await expect(createWebhookTransport({ resolve: publicDns, request: slow.send, timeoutMs: 15 })("https://example.com/hook", "{}", {})).rejects.toThrow("timeout");
    const request = vi.fn<Requester>();
    await expect(createWebhookTransport({ resolve: () => new Promise(() => {}), request, timeoutMs: 15 })("https://example.com/hook", "{}", {})).rejects.toThrow("timeout");
    expect(request).not.toHaveBeenCalled();
  });
});
