import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ImportFetchError,
  checkFetchUrl,
  guardedLookup,
  httpsTransport,
  safeFetch,
  type RawResponse,
  type Resolver,
  type Transport,
} from "./safe-fetch";

const DNS: Record<string, Array<{ address: string; family: number }>> = {
  "shop.example.com": [{ address: "93.184.216.34", family: 4 }],
  "cdn.example.com": [
    { address: "93.184.216.35", family: 4 },
    { address: "2606:2800:220:1::248", family: 6 },
  ],
  "metadata.example.com": [{ address: "169.254.169.254", family: 4 }],
  "mixed.example.com": [
    { address: "93.184.216.36", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ],
  "loop6.example.com": [{ address: "::1", family: 6 }],
};

const resolver: Resolver = async (hostname) => DNS[hostname] ?? [];

type Reply = { status: number; headers?: Record<string, string>; body?: Buffer | Readable };

/** A transport that runs the guarded lookup the way a socket connect
 * would, then answers from `routes`. */
function fakeTransport(routes: Record<string, Reply | ((init: Parameters<Transport>[1]) => Reply)>, seen: string[] = []): Transport {
  return async (url, init) => {
    await new Promise<void>((resolve, reject) =>
      init.lookup(url.hostname, { all: true }, (err) => (err ? reject(err) : resolve())),
    );
    seen.push(url.toString());
    const route = routes[url.toString()];
    const reply = typeof route === "function" ? route(init) : (route ?? { status: 404 });
    const body = reply.body instanceof Readable ? reply.body : Readable.from(reply.body ? [reply.body] : []);
    return { status: reply.status, headers: reply.headers ?? {}, body } satisfies RawResponse;
  };
}

const base = { accept: "*/*", maxBytes: 1024 * 1024, timeoutMs: 2000, resolver };

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof ImportFetchError ? err.reason : `other:${String(err)}`;
  }
  return "ok";
}

describe("checkFetchUrl", () => {
  it("accepts a plain https link and drops the fragment", () => {
    expect(checkFetchUrl("https://shop.example.com/products/mug#reviews").toString()).toBe(
      "https://shop.example.com/products/mug",
    );
    expect(checkFetchUrl("https://shop.example.com:443/x").toString()).toBe("https://shop.example.com/x");
  });

  it.each([
    ["http://shop.example.com/", "invalid_url"],
    ["ftp://shop.example.com/", "invalid_url"],
    ["file:///etc/passwd", "invalid_url"],
    ["gopher://shop.example.com/", "invalid_url"],
    ["https://user:pass@shop.example.com/", "invalid_url"],
    ["https://shop.example.com:8443/", "invalid_url"],
    ["not a url", "invalid_url"],
    ["https://127.0.0.1/", "blocked_host"],
    ["https://2130706433/", "blocked_host"],
    ["https://0x7f.1/", "blocked_host"],
    ["https://[::1]/", "blocked_host"],
    ["https://[::ffff:169.254.169.254]/", "blocked_host"],
    ["https://169.254.169.254/latest/meta-data/", "blocked_host"],
    ["https://localhost/", "blocked_host"],
    ["https://localhost./", "blocked_host"],
    ["https://api.localhost/", "blocked_host"],
    ["https://printer.local/", "blocked_host"],
    ["https://metadata.google.internal/", "blocked_host"],
    ["https://intranet/", "blocked_host"],
  ])("refuses %s as %s", (raw, reason) => {
    expect(() => checkFetchUrl(raw)).toThrowError(ImportFetchError);
    try {
      checkFetchUrl(raw);
    } catch (err) {
      expect((err as ImportFetchError).reason).toBe(reason);
    }
  });
});

describe("guardedLookup", () => {
  function run(hostname: string, options: { all?: boolean; family?: number }) {
    return new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      guardedLookup(resolver)(hostname, options, (err, address, family) => resolve({ err, address, family })),
    );
  }

  it("hands the socket only the checked addresses, in both call styles", async () => {
    const single = await run("cdn.example.com", {});
    expect(single.err).toBeNull();
    expect(single.address).toBe("93.184.216.35");
    expect(single.family).toBe(4);
    const all = await run("cdn.example.com", { all: true });
    expect(all.address).toEqual([
      { address: "93.184.216.35", family: 4 },
      { address: "2606:2800:220:1::248", family: 6 },
    ]);
    const v6 = await run("cdn.example.com", { family: 6 });
    expect(v6.address).toBe("2606:2800:220:1::248");
  });

  it("refuses a name when any of its addresses is private", async () => {
    for (const host of ["metadata.example.com", "mixed.example.com", "loop6.example.com"]) {
      const result = await run(host, { all: true });
      expect(result.err).toBeInstanceOf(ImportFetchError);
      expect((result.err as ImportFetchError).reason).toBe("blocked_host");
    }
  });

  it("reports a name with no addresses as not found", async () => {
    const result = await run("nothing.example.com", {});
    expect(result.err).toBeTruthy();
    expect((result.err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });
});

describe("safeFetch", () => {
  it("returns the body, status and content type", async () => {
    const transport = fakeTransport({
      "https://shop.example.com/a": { status: 200, headers: { "content-type": "Text/HTML" }, body: Buffer.from("hello") },
    });
    const result = await safeFetch("https://shop.example.com/a", { ...base, transport });
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/html");
    expect(result.body.toString()).toBe("hello");
    expect(result.url.toString()).toBe("https://shop.example.com/a");
  });

  it("follows a redirect to another public host and reports where it ended", async () => {
    const seen: string[] = [];
    const transport = fakeTransport(
      {
        "https://shop.example.com/a": { status: 301, headers: { location: "https://cdn.example.com/b" } },
        "https://cdn.example.com/b": { status: 200, body: Buffer.from("moved") },
      },
      seen,
    );
    const result = await safeFetch("https://shop.example.com/a", { ...base, transport });
    expect(result.body.toString()).toBe("moved");
    expect(result.url.hostname).toBe("cdn.example.com");
    expect(seen).toEqual(["https://shop.example.com/a", "https://cdn.example.com/b"]);
  });

  it("refuses a redirect to a private address, a bare IP, plain http or a custom port", async () => {
    for (const location of [
      "https://metadata.example.com/latest/meta-data/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "http://cdn.example.com/b",
      "https://cdn.example.com:8080/b",
    ]) {
      const seen: string[] = [];
      const transport = fakeTransport(
        {
          "https://shop.example.com/a": { status: 302, headers: { location } },
          "https://cdn.example.com/b": { status: 200 },
          "https://cdn.example.com:8080/b": { status: 200 },
        },
        seen,
      );
      const reason = await reasonOf(safeFetch("https://shop.example.com/a", { ...base, transport }));
      expect(["blocked_host", "invalid_url"]).toContain(reason);
      // Nothing past the first hop was ever requested.
      expect(seen).toEqual(["https://shop.example.com/a"]);
    }
  });

  it("refuses a first hop whose name resolves to a private address", async () => {
    const seen: string[] = [];
    const transport = fakeTransport({ "https://metadata.example.com/": { status: 200 } }, seen);
    expect(await reasonOf(safeFetch("https://metadata.example.com/", { ...base, transport }))).toBe("blocked_host");
    expect(seen).toEqual([]);
  });

  it("stops after three redirects", async () => {
    const transport = fakeTransport({
      "https://shop.example.com/1": { status: 302, headers: { location: "/2" } },
      "https://shop.example.com/2": { status: 302, headers: { location: "/3" } },
      "https://shop.example.com/3": { status: 302, headers: { location: "/4" } },
      "https://shop.example.com/4": { status: 302, headers: { location: "/5" } },
      "https://shop.example.com/5": { status: 200 },
    });
    expect(await reasonOf(safeFetch("https://shop.example.com/1", { ...base, transport }))).toBe("too_many_redirects");
  });

  it("refuses a declared length over the cap before reading", async () => {
    const transport = fakeTransport({
      "https://shop.example.com/big": { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } },
    });
    expect(await reasonOf(safeFetch("https://shop.example.com/big", { ...base, transport }))).toBe("too_large");
  });

  it("stops reading a body that grows past the cap", async () => {
    function* chunks() {
      for (let i = 0; i < 100; i += 1) {
        yield Buffer.alloc(64 * 1024, 1);
      }
    }
    const transport = fakeTransport({
      "https://shop.example.com/stream": { status: 200, body: Readable.from(chunks()) },
    });
    expect(
      await reasonOf(safeFetch("https://shop.example.com/stream", { ...base, maxBytes: 256 * 1024, transport })),
    ).toBe("too_large");
  });

  it("decompresses gzip and caps the decompressed size, so a compression bomb stops", async () => {
    const small = gzipSync(Buffer.from("<html>ok</html>"));
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100 * 1024);
    const transport = fakeTransport({
      "https://shop.example.com/small": { status: 200, headers: { "content-encoding": "gzip" }, body: small },
      "https://shop.example.com/bomb": { status: 200, headers: { "content-encoding": "gzip" }, body: bomb },
    });
    const ok = await safeFetch("https://shop.example.com/small", { ...base, transport });
    expect(ok.body.toString()).toBe("<html>ok</html>");
    expect(await reasonOf(safeFetch("https://shop.example.com/bomb", { ...base, transport }))).toBe("too_large");
  });

  it("gives up on a body that trickles past the deadline", async () => {
    const transport = fakeTransport({
      "https://shop.example.com/slow": (init) => {
        const body = new Readable({ read() {} });
        body.push("partial");
        init.signal.addEventListener("abort", () => body.destroy(new Error("aborted")));
        return { status: 200, body };
      },
    });
    expect(await reasonOf(safeFetch("https://shop.example.com/slow", { ...base, timeoutMs: 50, transport }))).toBe(
      "timeout",
    );
  });

  it("uses the guarded lookup on a real https connection, refusing before any socket opens", async () => {
    const reason = await reasonOf(
      safeFetch("https://rebind.example.com/", {
        ...base,
        transport: httpsTransport,
        resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    );
    expect(reason).toBe("blocked_host");
  });
});
