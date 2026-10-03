import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request, createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMaintenanceServer, readMaintenanceConfig } from "./maintenance-server.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const executable = fileURLToPath(new URL("./maintenance-server.mjs", import.meta.url));

async function startServer(t) {
  const runtime = createMaintenanceServer({ commit: COMMIT });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  t.after(() => runtime.shutdown());
  return { ...runtime, port: runtime.server.address().port };
}

async function http(port, path, method = "GET", headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function rawHttp(port, message) {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  socket.setTimeout(2_000, () => socket.destroy(new Error("HTTP response timed out")));
  let response = "";
  socket.on("data", (chunk) => { response += chunk; });
  await once(socket, "connect");
  socket.write(message);
  await once(socket, "end");
  socket.destroy();
  return response;
}

async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startChild(t) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [executable], {
    env: { PORT: String(port), RENDER_GIT_COMMIT: COMMIT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const ready = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Maintenance startup timed out")), 5_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Maintenance exited before readiness")); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(output.trim()));
      }
    });
  });
  assert.deepEqual(ready, { event: "maintenance_listening", mode: "migration_maintenance", port, commit: COMMIT });
  return { child, exited, port };
}

test("configuration reads only the public port and build identity", () => {
  const values = { PORT: "10000", RENDER_GIT_COMMIT: COMMIT };
  const env = new Proxy(values, {
    get(target, name) {
      assert.ok(name === "PORT" || name === "RENDER_GIT_COMMIT", `Unexpected environment access: ${String(name)}`);
      return target[name];
    },
    ownKeys() { throw new Error("Environment must not be enumerated"); },
  });
  assert.deepEqual(readMaintenanceConfig(env), { port: 10000, commit: COMMIT });
  assert.deepEqual(readMaintenanceConfig({ PORT: "1" }), { port: 1, commit: null });
  assert.equal(readMaintenanceConfig({ PORT: "65535" }).port, 65535);
});

test("invalid ports and unvalidated public identity cannot start the runtime", () => {
  for (const PORT of [undefined, "", "0", "-1", "65536", "100000", "1.5", "1e3", " 3000", "3000 ", "03000", "3000\n", "localhost:3000"]) {
    assert.throws(() => readMaintenanceConfig({ PORT }), /PORT/);
  }
  for (const RENDER_GIT_COMMIT of ["", "short", "a".repeat(39), "a".repeat(41), "G".repeat(40), `${COMMIT}\n`, "<script>alert(1)</script>"]) {
    assert.throws(() => readMaintenanceConfig({ PORT: "3000", RENDER_GIT_COMMIT }), /RENDER_GIT_COMMIT/);
  }
});

test("the executable fails closed without echoing invalid configuration", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, [executable], {
    env: { PORT: "invalid-port-do-not-echo", RENDER_GIT_COMMIT: "invalid-commit-do-not-echo" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.deepEqual(await once(child, "close"), [1, null]);
  assert.equal(stdout, "");
  assert.equal(stderr, "Maintenance server could not start. Check PORT and the public commit SHA.\n");
});

test("only exact GET health identifies an inert process, without app readiness", async (t) => {
  const { port } = await startServer(t);
  const health = await http(port, "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers["cache-control"], "no-store");
  assert.equal(health.headers["connection"], "close");
  assert.deepEqual(JSON.parse(health.body), { mode: "migration_maintenance", applicationReady: false, commit: COMMIT });
  assert.doesNotMatch(health.body, /"ok":true|"status":"ok"/);
  const authorized = await http(port, "/api/health", "GET", { Authorization: "Bearer ignored-test-value" });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body, health.body);
});

test("customer, internal, authenticated and non-GET requests stay unavailable", async (t) => {
  const { port } = await startServer(t);
  const targets = ["/", "/app", "/api/health/", "/api/health?protected=1", "/api/health?", "/api/%68ealth", "/api//health", "/api/cron/stale", "/api/cron/purge", "/api/ops/deploy-pending", "/api/mcp", "/api/webhooks/stripe", "http://curvi.ai/api/health"];
  for (const path of targets) {
    const response = await http(port, path, "GET", { Authorization: "Bearer ignored-test-value" });
    assert.equal(response.status, 503, path);
    assert.equal(response.headers["cache-control"], "no-store", path);
    assert.equal(response.headers["retry-after"], "60", path);
    assert.equal(JSON.parse(response.body).applicationReady, false, path);
  }
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    const response = await http(port, "/api/health", method);
    assert.equal(response.status, 503, method);
    assert.equal(response.headers["retry-after"], "60", method);
    if (method === "HEAD") assert.equal(response.body, "");
  }
});

test("uploads, unexpected expectations, upgrades and CONNECT do not open another handler", async (t) => {
  const { port } = await startServer(t);
  for (const message of [
    "POST /api/health HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 1000\r\n\r\n",
    "POST /api/health HTTP/1.1\r\nHost: localhost\r\nExpect: something-else\r\nContent-Length: 1000\r\n\r\n",
    "GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost\r\n\r\n",
  ]) {
    const response = await rawHttp(port, message);
    assert.match(response, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
    assert.match(response, /Retry-After: 60\r\n/);
    assert.match(response, /Cache-Control: no-store\r\n/);
    assert.doesNotMatch(response, /100 Continue|101 Switching Protocols/);
  }
});

test("SIGTERM closes the executable cleanly and releases its port", { timeout: 10_000 }, async (t) => {
  const { child, exited, port } = await startChild(t);
  assert.equal((await http(port, "/api/health")).status, 200);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
  await assert.rejects(http(port, "/api/health"), { code: "ECONNREFUSED" });
});

test("a refused protocol tunnel cannot keep shutdown alive with a half-open socket", { timeout: 8_000 }, async (t) => {
  const { child, exited, port } = await startChild(t);
  const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  socket.setEncoding("utf8");
  let response = "";
  socket.on("data", (chunk) => { response += chunk; });
  await once(socket, "connect");
  socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await once(socket, "end");
  assert.match(response, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null]);
});

test("SIGINT has a bounded shutdown even with an incomplete request", { timeout: 10_000 }, async (t) => {
  const { child, exited, port } = await startChild(t);
  const socket = connect({ host: "127.0.0.1", port });
  t.after(() => socket.destroy());
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write("GET /api/health HTTP/1.1\r\nHost:");
  const started = Date.now();
  child.kill("SIGINT");
  child.kill("SIGINT");
  assert.deepEqual(await exited, [0, null]);
  assert.ok(Date.now() - started < 8_000, "Shutdown exceeded the bounded grace period");
});

test("requests already connected at shutdown cannot obtain healthy status", { timeout: 10_000 }, async (t) => {
  const { server, shutdown, port } = await startServer(t);
  const connection = once(server, "connection");
  const socket = connect({ host: "127.0.0.1", port });
  t.after(() => socket.destroy());
  socket.setEncoding("utf8");
  let response = "";
  socket.on("data", (chunk) => { response += chunk; });
  await once(socket, "connect");
  await connection;
  socket.write("GET /api/health HTTP/1.1\r\nHost:");
  const stopping = shutdown();
  assert.strictEqual(shutdown(), stopping);
  socket.write(" localhost\r\n\r\n");
  await once(socket, "end");
  await stopping;
  assert.match(response, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
});
