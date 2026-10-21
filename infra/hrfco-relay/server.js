"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const DEFAULT_PORT = 8090;
const UPSTREAM_BASE_URL = "https://api.hrfco.go.kr";
// /<serviceKey>/waterlevel/info.json and /<serviceKey>/waterlevel/list/10M/<stationCode>.json
const ALLOWED_PATH = /^\/[A-Za-z0-9-]+\/waterlevel\/(?:info\.json|list\/10M\/[A-Za-z0-9]+\.json)$/;

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBearer(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function createServer({ env = process.env, fetchImpl = global.fetch } = {}) {
  const relayToken = String(env.HRFCO_RELAY_TOKEN || "").trim();
  const timeoutMs = Number.parseInt(env.HRFCO_RELAY_TIMEOUT_MS || "20000", 10);

  async function handle(request, response) {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { ok: true });
    }
    if (request.method !== "GET" || !ALLOWED_PATH.test(request.url)) {
      return json(response, 404, { error: "not_found" });
    }
    if (!relayToken) {
      return json(response, 503, { error: "relay_not_configured" });
    }
    const providedToken = parseBearer(request.headers.authorization);
    if (!providedToken || !constantTimeEqual(providedToken, relayToken)) {
      return json(response, 401, { error: "unauthorized" });
    }

    let upstream;
    try {
      upstream = await fetchImpl(`${UPSTREAM_BASE_URL}${request.url}`, {
        headers: { accept: "application/json", "user-agent": "k-skill-hrfco-relay" },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      return json(response, 502, { error: "upstream_unreachable" });
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store"
    });
    response.end(body);
  }

  return http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "relay_error" });
    });
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.HRFCO_RELAY_PORT || DEFAULT_PORT, 10);
  createServer().listen(port, "127.0.0.1", () => {
    console.log(`hrfco relay listening on 127.0.0.1:${port}`);
  });
}

module.exports = { ALLOWED_PATH, createServer };
