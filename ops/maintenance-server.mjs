import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MODE = "migration_maintenance";
const SHUTDOWN_GRACE_MS = 5_000;

// Deliberately independent of the app's env helper and its import graph.
export function readMaintenanceConfig(environment) {
  const port = environment.PORT;
  const commit = environment.RENDER_GIT_COMMIT;
  if (typeof port !== "string" || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65_535) {
    throw new Error("Maintenance server requires PORT to be an integer from 1 to 65535.");
  }
  if (commit !== undefined && (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))) {
    throw new Error("Maintenance server requires a full lowercase RENDER_GIT_COMMIT SHA when supplied.");
  }
  return { port: Number(port), commit: commit ?? null };
}

export function createMaintenanceServer({ commit }) {
  const healthBody = JSON.stringify({ mode: MODE, applicationReady: false, commit });
  const unavailableBody = JSON.stringify({
    mode: MODE,
    applicationReady: false,
    message: "Curvi is temporarily unavailable for maintenance. Please try again shortly.",
  });
  const sockets = new Set();
  let stopping = false;
  let shutdownPromise;

  const headers = (body, status) => ({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Connection": "close",
    "X-Content-Type-Options": "nosniff",
    ...(status === 503 ? { "Retry-After": "60" } : {}),
  });
  const respond = (request, response) => {
    const health = !stopping && request.method === "GET" && request.url === "/api/health";
    const status = health ? 200 : 503;
    const body = health ? healthBody : unavailableBody;
    response.writeHead(status, headers(body, status));
    response.end(body);
  };
  const server = createServer({
    maxHeaderSize: 8_192,
    headersTimeout: 5_000,
    requestTimeout: 5_000,
    keepAliveTimeout: 1_000,
  }, respond);

  // Never acknowledge an upload with an automatic 100 Continue response.
  server.on("checkContinue", respond);
  server.on("checkExpectation", respond);
  const refuseUpgrade = (_request, socket) => {
    socket.on("error", () => socket.destroy());
    const responseHeaders = Object.entries(headers(unavailableBody, 503))
      .map(([name, value]) => `${name}: ${value}`).join("\r\n");
    socket.end(`HTTP/1.1 503 Service Unavailable\r\n${responseHeaders}\r\n\r\n${unavailableBody}`, () => socket.destroy());
  };
  server.on("connect", refuseUpgrade);
  server.on("upgrade", refuseUpgrade);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, SHUTDOWN_GRACE_MS);
      timer.unref();
      server.close(() => {
        clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        resolve();
      });
    });
    return shutdownPromise;
  };

  return { server, shutdown };
}

async function main() {
  const config = readMaintenanceConfig(process.env);
  const { server, shutdown } = createMaintenanceServer(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { void shutdown(); });
  }
  console.log(JSON.stringify({ event: "maintenance_listening", mode: MODE, ...config }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("Maintenance server could not start. Check PORT and the public commit SHA.");
    process.exitCode = 1;
  });
}
