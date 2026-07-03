const test = require("node:test");
const assert = require("node:assert");
const { gobouncer, ipKey, headerKey } = require("./dist/index.js");

test("ipKey returns client IP", () => {
  const req = { ip: "1.2.3.4", headers: {} };
  assert.strictEqual(ipKey(req), "ip:1.2.3.4");
});

test("ipKey falls back to unknown if IP is missing", () => {
  const req = { headers: {} };
  assert.strictEqual(ipKey(req), "ip:unknown");
});

test("headerKey reads specific header", () => {
  const req = { headers: { "x-user-id": "user_123" } };
  const keyFn = headerKey("X-User-ID");
  assert.strictEqual(keyFn(req), "x-user-id:user_123");
});

test("headerKey falls back to ipKey if header is missing", () => {
  const req = { ip: "1.2.3.4", headers: {} };
  const keyFn = headerKey("X-User-ID");
  assert.strictEqual(keyFn(req), "ip:1.2.3.4");
});

test("GoBouncerClient constructor options", () => {
  const client = gobouncer({ url: "http://localhost:8080/", apiKey: "secret" });
  assert.strictEqual(client.url, "http://localhost:8080");
  assert.strictEqual(client.timeoutMs, 150);
  assert.strictEqual(client.failOpen, true);
  assert.strictEqual(client.apiKey, "secret");
});

test("GoBouncerClient fallback behaves according to failOpen", () => {
  const clientOpen = gobouncer({ url: "http://localhost:8080", failOpen: true });
  assert.deepStrictEqual(clientOpen.fallback(), { allowed: true, remaining: -1 });

  const clientClosed = gobouncer({ url: "http://localhost:8080", failOpen: false });
  assert.deepStrictEqual(clientClosed.fallback(), { allowed: false, remaining: 0, retry_after: 0 });
});

test("GoBouncerClient.check() makes successful HTTP post", async (t) => {
  const client = gobouncer({ url: "http://localhost:8080" });
  
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init) => {
    assert.strictEqual(input, "http://localhost:8080/check");
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(
      init.headers["Content-Type"],
      "application/json"
    );
    
    const body = JSON.parse(init.body);
    assert.deepStrictEqual(body, {
      key: "test-key",
      limit: 10,
      window_ms: 60000,
      algorithm: "sliding_window",
    });

    return {
      ok: true,
      json: async () => ({ allowed: true, remaining: 9 }),
    };
  };

  const result = await client.check("test-key", 10, 60000);
  assert.deepStrictEqual(result, { allowed: true, remaining: 9 });
});

test("GoBouncerClient.check() handles fetch error with failOpen", async (t) => {
  const client = gobouncer({ url: "http://localhost:8080", failOpen: true });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new Error("Network error");
  };

  const result = await client.check("test-key", 10, 60000);
  assert.deepStrictEqual(result, { allowed: true, remaining: -1 });
});

test("GoBouncerClient.limit() middleware allowed flow", async (t) => {
  const client = gobouncer({ url: "http://localhost:8080" });
  
  // mock check
  client.check = async () => ({ allowed: true, remaining: 5 });

  const middleware = client.limit({ max: 10, windowMs: 60000 });

  const req = { ip: "1.2.3.4", headers: {} };
  const headersSet = {};
  const res = {
    setHeader(name, value) {
      headersSet[name] = value;
    },
    status() { return this; },
    json() { return this; },
  };

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  await middleware(req, res, next);

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(headersSet["X-RateLimit-Limit"], 10);
  assert.strictEqual(headersSet["X-RateLimit-Remaining"], 5);
});

test("GoBouncerClient.limit() middleware denied flow", async (t) => {
  const client = gobouncer({ url: "http://localhost:8080" });
  
  // mock check
  client.check = async () => ({ allowed: false, remaining: 0, retry_after: 5000 });

  const middleware = client.limit({ max: 10, windowMs: 60000 });

  const req = { ip: "1.2.3.4", headers: {} };
  const headersSet = {};
  let responseStatus = 0;
  let responseBody = null;

  const res = {
    setHeader(name, value) {
      headersSet[name] = value;
    },
    status(code) { 
      responseStatus = code;
      return this; 
    },
    json(body) { 
      responseBody = body;
      return this; 
    },
  };

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  await middleware(req, res, next);

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(headersSet["X-RateLimit-Limit"], 10);
  assert.strictEqual(headersSet["X-RateLimit-Remaining"], 0);
  assert.strictEqual(headersSet["Retry-After"], 5); // 5000 ms -> 5 s
  assert.strictEqual(responseStatus, 429);
  assert.deepStrictEqual(responseBody, {
    error: "too many requests",
    retry_after_ms: 5000,
  });
});
