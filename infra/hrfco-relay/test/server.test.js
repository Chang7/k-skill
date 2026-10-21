"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server");

async function withServer(options, callback) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("rejects requests without the relay bearer token before touching upstream", async () => {
  let upstreamCalls = 0;
  await withServer({
    env: { HRFCO_RELAY_TOKEN: "secret" },
    fetchImpl: async () => { upstreamCalls += 1; return new Response("{}"); }
  }, async (base) => {
    const path = "/key-1/waterlevel/info.json";
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    assert.equal((await fetch(`${base}${path}`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  });
  assert.equal(upstreamCalls, 0);
});

test("forwards only the two allowed water-level paths to api.hrfco.go.kr", async () => {
  const calls = [];
  await withServer({
    env: { HRFCO_RELAY_TOKEN: "secret" },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ content: [] }), { headers: { "content-type": "application/json" } });
    }
  }, async (base) => {
    const headers = { authorization: "Bearer secret" };
    const info = await fetch(`${base}/key-1/waterlevel/info.json`, { headers });
    const list = await fetch(`${base}/key-1/waterlevel/list/10M/1018683.json`, { headers });
    assert.equal(info.status, 200);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { content: [] });

    for (const blocked of [
      "/key-1/rainfall/info.json",
      "/key-1/waterlevel/list/1D/1018683.json",
      "/key-1/waterlevel/info.json/../../x",
      "/key-1/waterlevel/list/10M/../info.json"
    ]) {
      assert.equal((await fetch(`${base}${blocked}`, { headers })).status, 404, blocked);
    }
  });
  assert.deepEqual(calls, [
    "https://api.hrfco.go.kr/key-1/waterlevel/info.json",
    "https://api.hrfco.go.kr/key-1/waterlevel/list/10M/1018683.json"
  ]);
});

test("passes upstream status through and reports unreachable upstream as 502", async () => {
  await withServer({
    env: { HRFCO_RELAY_TOKEN: "secret" },
    fetchImpl: async () => new Response("denied", { status: 403 })
  }, async (base) => {
    const res = await fetch(`${base}/key-1/waterlevel/info.json`, { headers: { authorization: "Bearer secret" } });
    assert.equal(res.status, 403);
  });

  await withServer({
    env: { HRFCO_RELAY_TOKEN: "secret" },
    fetchImpl: async () => { throw new Error("fetch failed"); }
  }, async (base) => {
    const res = await fetch(`${base}/key-1/waterlevel/info.json`, { headers: { authorization: "Bearer secret" } });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "upstream_unreachable");
  });
});

test("answers 503 when no relay token is configured", async () => {
  await withServer({ env: {}, fetchImpl: async () => new Response("{}") }, async (base) => {
    const res = await fetch(`${base}/key-1/waterlevel/info.json`, { headers: { authorization: "Bearer x" } });
    assert.equal(res.status, 503);
  });
});
