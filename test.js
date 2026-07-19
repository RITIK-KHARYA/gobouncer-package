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

test("GoBouncerClient.checkPolicy() makes successful HTTP post", async (t) => {
  const client = gobouncer({ url: "http://localhost:8080", apiKey: "secret" });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (input, init) => {
    assert.strictEqual(input, "http://localhost:8080/check");
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(init.headers["Content-Type"], "application/json");
    assert.strictEqual(init.headers["X-GoBouncer-Key"], "secret");

    const body = JSON.parse(init.body);
    assert.deepStrictEqual(body, {
      key: "user:123",
      policy: "login",
    });

    return {
      ok: true,
      headers: {
        get(name) {
          if (name === "X-RateLimit-Limit") return "5";
          if (name === "X-RateLimit-Policy") return "login";
          return null;
        },
      },
      json: async () => ({ allowed: true, remaining: 4 }),
    };
  };

  const result = await client.checkPolicy("user:123", "login");
  assert.deepStrictEqual(result, {
    allowed: true,
    remaining: 4,
    limit: 5,
    policy: "login",
  });
});

test("GoBouncerClient.limit() middleware allowed flow", async () => {
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

test("GoBouncerClient.limit() middleware denied flow", async () => {
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

test("GoBouncerClient.policy() middleware allowed flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.checkPolicy = async () => ({
    allowed: true,
    remaining: 4,
    limit: 5,
    policy: "login",
  });

  const middleware = client.policy({ name: "login" });

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
  await middleware(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(headersSet["X-RateLimit-Policy"], "login");
  assert.strictEqual(headersSet["X-RateLimit-Limit"], 5);
  assert.strictEqual(headersSet["X-RateLimit-Remaining"], 4);
});

test("GoBouncerClient.policy() middleware denied flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.checkPolicy = async () => ({
    allowed: false,
    remaining: 0,
    retry_after: 5000,
    policy: "login",
  });

  const middleware = client.policy({
    name: "login",
    key: (req) => `login:${req.ip}`,
  });

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
  await middleware(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(headersSet["X-RateLimit-Policy"], "login");
  assert.strictEqual(headersSet["X-RateLimit-Remaining"], 0);
  assert.strictEqual(headersSet["Retry-After"], 5);
  assert.strictEqual(responseStatus, 429);
  assert.deepStrictEqual(responseBody, {
    error: "too many requests",
    retry_after_ms: 5000,
  });
});

test("GoBouncerClient.use() applies local policy settings", async () => {
  const client = gobouncer({
    url: "http://localhost:8080",
    policies: {
      profileRead: { algorithm: "gcra", limit: 100, windowMs: 60000 },
      otpVerify: { algorithm: "sliding-window", limit: 5, windowMs: 60000 },
    },
  });

  let captured = null;
  client.check = async (key, max, windowMs, algorithm) => {
    captured = { key, max, windowMs, algorithm };
    return { allowed: true, remaining: 99 };
  };

  const middleware = client.use("profileRead", {
    key: (req) => `user:${req.headers["x-user-id"]}`,
  });

  const req = { ip: "1.2.3.4", headers: { "x-user-id": "user_123" } };
  const res = {
    setHeader() {},
    status() { return this; },
    json() { return this; },
  };

  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(captured, {
    key: "ratelimit:profileRead:gcra:user:user_123",
    max: 100,
    windowMs: 60000,
    algorithm: "gcra",
  });
});

test("GoBouncerClient.use() namespaces same user across different policies", async () => {
  const client = gobouncer({
    url: "http://localhost:8080",
    policies: {
      profileRead: { algorithm: "gcra", limit: 100, windowMs: 60000 },
      otpVerify: { algorithm: "sliding-window", limit: 5, windowMs: 60000 },
    },
  });

  const capturedKeys = [];
  client.check = async (key) => {
    capturedKeys.push(key);
    return { allowed: true, remaining: 1 };
  };

  const req = { ip: "1.2.3.4", headers: { "x-user-id": "42" } };
  const res = {
    setHeader() {},
    status() { return this; },
    json() { return this; },
  };
  const key = (request) => `user:${request.headers["x-user-id"]}`;

  await client.use("profileRead", { key })(req, res, () => {});
  await client.use("otpVerify", { key })(req, res, () => {});

  assert.deepStrictEqual(capturedKeys, [
    "ratelimit:profileRead:gcra:user:42",
    "ratelimit:otpVerify:sliding_window:user:42",
  ]);
});

test("GoBouncerClient.use() falls back to server-side named policy", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });

  let captured = null;
  client.checkPolicy = async (key, policy) => {
    captured = { key, policy };
    return { allowed: true, remaining: 4, policy };
  };

  const middleware = client.use("login");

  const req = { ip: "1.2.3.4", headers: {} };
  const res = {
    setHeader() {},
    status() { return this; },
    json() { return this; },
  };

  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(captured, {
    key: "ip:1.2.3.4",
    policy: "login",
  });
});

// Hono middleware tests

const { honoLimit, honoPolicy, honoUse, honoIpKey, honoHeaderKey } = require("./dist/hono.js");

/**
 * Create a minimal mock of Hono's Context object.
 * Only the methods used by our adapter are implemented.
 */
function createMockContext(headersMap = {}) {
  const responseHeaders = {};
  let jsonResult = null;

  return {
    req: {
      header(name) {
        return headersMap[name.toLowerCase()] ?? undefined;
      },
    },
    header(name, value) {
      responseHeaders[name] = value;
    },
    json(body, status) {
      jsonResult = { body, status };
      return jsonResult;
    },
    // Expose internals for assertions
    _responseHeaders: responseHeaders,
    _getJsonResult: () => jsonResult,
  };
}

test("honoIpKey extracts IP from x-forwarded-for", () => {
  const c = createMockContext({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" });
  assert.strictEqual(honoIpKey(c), "ip:10.0.0.1");
});

test("honoIpKey falls back to x-real-ip", () => {
  const c = createMockContext({ "x-real-ip": "192.168.1.1" });
  assert.strictEqual(honoIpKey(c), "ip:192.168.1.1");
});

test("honoIpKey falls back to unknown when no IP headers present", () => {
  const c = createMockContext({});
  assert.strictEqual(honoIpKey(c), "ip:unknown");
});

test("honoHeaderKey reads specific header", () => {
  const keyFn = honoHeaderKey("X-API-Key");
  const c = createMockContext({ "x-api-key": "abc123" });
  assert.strictEqual(keyFn(c), "x-api-key:abc123");
});

test("honoHeaderKey falls back to IP if header is missing", () => {
  const keyFn = honoHeaderKey("X-API-Key");
  const c = createMockContext({ "x-forwarded-for": "10.0.0.1" });
  assert.strictEqual(keyFn(c), "ip:10.0.0.1");
});

test("honoLimit allowed flow - sets headers and calls next()", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: true, remaining: 7 });

  const middleware = honoLimit(client, { max: 10, windowMs: 60000 });

  const c = createMockContext({ "x-forwarded-for": "10.0.0.1" });
  let nextCalled = false;
  const next = async () => { nextCalled = true; };

  const result = await middleware(c, next);

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(result, undefined);
  assert.strictEqual(c._responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(c._responseHeaders["X-RateLimit-Remaining"], "7");
});

test("honoLimit denied flow - returns 429 with correct body and headers", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: false, remaining: 0, retry_after: 3000 });

  const middleware = honoLimit(client, { max: 10, windowMs: 60000 });

  const c = createMockContext({ "x-forwarded-for": "10.0.0.1" });
  let nextCalled = false;
  const next = async () => { nextCalled = true; };

  await middleware(c, next);

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(c._responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(c._responseHeaders["X-RateLimit-Remaining"], "0");
  assert.strictEqual(c._responseHeaders["Retry-After"], "3");

  const jsonResult = c._getJsonResult();
  assert.strictEqual(jsonResult.status, 429);
  assert.deepStrictEqual(jsonResult.body, {
    error: "too many requests",
    retry_after_ms: 3000,
  });
});

test("honoLimit uses custom key function", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });

  let capturedKey = null;
  client.check = async (key) => {
    capturedKey = key;
    return { allowed: true, remaining: 5 };
  };

  const customKey = (c) => `tenant:${c.req.header("x-tenant-id") ?? "default"}`;

  const middleware = honoLimit(client, {
    max: 50,
    windowMs: 60000,
    key: customKey,
  });

  const c = createMockContext({ "x-tenant-id": "acme-corp" });
  await middleware(c, async () => {});

  assert.strictEqual(capturedKey, "tenant:acme-corp");
});

test("honoLimit uses custom algorithm", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });

  let capturedAlgorithm = null;
  client.check = async (key, max, windowMs, algorithm) => {
    capturedAlgorithm = algorithm;
    return { allowed: true, remaining: 5 };
  };

  const middleware = honoLimit(client, {
    max: 10,
    windowMs: 60000,
    algorithm: "gcra",
  });

  const c = createMockContext({ "x-forwarded-for": "10.0.0.1" });
  await middleware(c, async () => {});

  assert.strictEqual(capturedAlgorithm, "gcra");
});

test("honoPolicy allowed flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.checkPolicy = async () => ({
    allowed: true,
    remaining: 4,
    limit: 5,
    policy: "login",
  });

  const middleware = honoPolicy(client, { name: "login" });

  const c = createMockContext({ "x-forwarded-for": "10.0.0.1" });
  let nextCalled = false;
  await middleware(c, async () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(c._responseHeaders["X-RateLimit-Policy"], "login");
  assert.strictEqual(c._responseHeaders["X-RateLimit-Limit"], "5");
  assert.strictEqual(c._responseHeaders["X-RateLimit-Remaining"], "4");
});

test("honoPolicy denied flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.checkPolicy = async () => ({
    allowed: false,
    remaining: 0,
    retry_after: 3000,
    policy: "login",
  });

  const middleware = honoPolicy(client, {
    name: "login",
    key: (c) => `login:${c.req.header("x-user-id") ?? "anon"}`,
  });

  const c = createMockContext({ "x-user-id": "user_123" });
  let nextCalled = false;
  await middleware(c, async () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(c._responseHeaders["X-RateLimit-Policy"], "login");
  assert.strictEqual(c._responseHeaders["X-RateLimit-Remaining"], "0");
  assert.strictEqual(c._responseHeaders["Retry-After"], "3");

  const jsonResult = c._getJsonResult();
  assert.strictEqual(jsonResult.status, 429);
  assert.deepStrictEqual(jsonResult.body, {
    error: "too many requests",
    retry_after_ms: 3000,
  });
});

test("honoUse applies local policy settings", async () => {
  const client = gobouncer({
    url: "http://localhost:8080",
    policies: {
      profileRead: { algorithm: "gcra", limit: 100, windowMs: 60000 },
    },
  });

  let captured = null;
  client.check = async (key, max, windowMs, algorithm) => {
    captured = { key, max, windowMs, algorithm };
    return { allowed: true, remaining: 99 };
  };

  const middleware = honoUse(client, "profileRead", {
    key: (c) => `user:${c.req.header("x-user-id")}`,
  });

  const c = createMockContext({ "x-user-id": "user_123" });
  let nextCalled = false;
  await middleware(c, async () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(captured, {
    key: "ratelimit:profileRead:gcra:user:user_123",
    max: 100,
    windowMs: 60000,
    algorithm: "gcra",
  });
});

// New Tests for Phase 2 DX & Observability

test("GoBouncerClient triggers onError on connection failure", async (t) => {
  let capturedError = null;
  const client = gobouncer({
    url: "http://localhost:8080",
    onError: (err) => {
      capturedError = err;
    },
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new Error("DNS resolution failed");
  };

  const result = await client.check("test-key", 10, 60000);
  assert.deepStrictEqual(result, { allowed: true, remaining: -1 });
  assert.ok(capturedError instanceof Error);
  assert.strictEqual(capturedError.message, "DNS resolution failed");
});

test("GoBouncerClient triggers onError on non-2xx status code", async (t) => {
  let capturedError = null;
  const client = gobouncer({
    url: "http://localhost:8080",
    onError: (err) => {
      capturedError = err;
    },
  });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    return {
      ok: false,
      status: 502,
    };
  };

  const result = await client.check("test-key", 10, 60000);
  assert.deepStrictEqual(result, { allowed: true, remaining: -1 });
  assert.ok(capturedError instanceof Error);
  assert.strictEqual(capturedError.message, "GoBouncer returned status 502");
});

test("GoBouncerClient.ping() returns true on successful health response", async (t) => {
  const client = gobouncer({ url: "http://localhost:8080" });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calledUrl = null;
  globalThis.fetch = async (url) => {
    calledUrl = url;
    return { ok: true };
  };

  const isOnline = await client.ping();
  assert.strictEqual(isOnline, true);
  assert.strictEqual(calledUrl, "http://localhost:8080/health");
});

test("GoBouncerClient.ping() falls back to root path on health failure", async (t) => {
  const client = gobouncer({ url: "http://localhost:8080" });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calledUrls = [];
  globalThis.fetch = async (url) => {
    calledUrls.push(url);
    if (url.endsWith("/health")) {
      throw new Error("Not Found");
    }
    return { ok: true };
  };

  const isOnline = await client.ping();
  assert.strictEqual(isOnline, true);
  assert.deepStrictEqual(calledUrls, [
    "http://localhost:8080/health",
    "http://localhost:8080/",
  ]);
});

test("GoBouncerClient.ping() returns false when both fail", async (t) => {
  const client = gobouncer({ url: "http://localhost:8080" });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => {
    throw new Error("Offline");
  };

  const isOnline = await client.ping();
  assert.strictEqual(isOnline, false);
});

test("GoBouncerClient.limit() sets X-RateLimit-Reset when retry_after is present", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: false, remaining: 0, retry_after: 5000 });

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

  await middleware(req, res, () => {});

  assert.strictEqual(headersSet["X-RateLimit-Limit"], 10);
  assert.strictEqual(headersSet["X-RateLimit-Remaining"], 0);
  assert.ok(typeof headersSet["X-RateLimit-Reset"] === "number");
  assert.ok(headersSet["X-RateLimit-Reset"] > Math.floor(Date.now() / 1000));
});

test("honoLimit sets X-RateLimit-Reset when retry_after is present", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: false, remaining: 0, retry_after: 5000 });

  const middleware = honoLimit(client, { max: 10, windowMs: 60000 });

  const c = createMockContext({ "x-forwarded-for": "10.0.0.1" });
  await middleware(c, async () => {});

  assert.strictEqual(c._responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(c._responseHeaders["X-RateLimit-Remaining"], "0");
  assert.ok(typeof c._responseHeaders["X-RateLimit-Reset"] === "string");
  const resetTimestamp = parseInt(c._responseHeaders["X-RateLimit-Reset"]);
  assert.ok(resetTimestamp > Math.floor(Date.now() / 1000));
});

// Fastify middleware tests

const { fastifyLimit, fastifyUse, fastifyIpKey, fastifyHeaderKey } = require("./dist/fastify.js");

function createMockFastify(headers = {}, ip = "1.2.3.4") {
  const responseHeaders = {};
  let responseStatus = 200;
  let sentBody = null;

  const req = {
    ip,
    headers,
  };

  const reply = {
    header(name, value) {
      responseHeaders[name] = value;
      return this;
    },
    status(code) {
      responseStatus = code;
      return this;
    },
    send(body) {
      sentBody = body;
      return this;
    },
  };

  return { req, reply, responseHeaders, getStatus: () => responseStatus, getBody: () => sentBody };
}

test("fastifyIpKey extracts IP", () => {
  const { req } = createMockFastify({}, "10.0.0.1");
  assert.strictEqual(fastifyIpKey(req), "ip:10.0.0.1");
});

test("fastifyHeaderKey reads specific header", () => {
  const keyFn = fastifyHeaderKey("X-API-Key");
  const { req } = createMockFastify({ "x-api-key": "abc" });
  assert.strictEqual(keyFn(req), "x-api-key:abc");
});

test("fastifyLimit allowed flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: true, remaining: 5 });

  const hook = fastifyLimit(client, { max: 10, windowMs: 60000 });
  const { req, reply, responseHeaders, getStatus, getBody } = createMockFastify();

  await hook(req, reply);

  assert.strictEqual(getStatus(), 200);
  assert.strictEqual(getBody(), null);
  assert.strictEqual(responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(responseHeaders["X-RateLimit-Remaining"], "5");
});

test("fastifyLimit denied flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: false, remaining: 0, retry_after: 3000 });

  const hook = fastifyLimit(client, { max: 10, windowMs: 60000 });
  const { req, reply, responseHeaders, getStatus, getBody } = createMockFastify();

  await hook(req, reply);

  assert.strictEqual(getStatus(), 429);
  assert.deepStrictEqual(getBody(), { error: "too many requests", retry_after_ms: 3000 });
  assert.strictEqual(responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(responseHeaders["X-RateLimit-Remaining"], "0");
  assert.strictEqual(responseHeaders["Retry-After"], "3");
  assert.ok(responseHeaders["X-RateLimit-Reset"]);
});

test("fastifyUse falls back to server-side named policy", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.checkPolicy = async (key, policy) => ({
    allowed: false,
    remaining: 0,
    retry_after: 3000,
    policy,
    limit: 5,
  });

  const hook = fastifyUse(client, "login");
  const { req, reply, responseHeaders, getStatus, getBody } = createMockFastify();

  await hook(req, reply);

  assert.strictEqual(getStatus(), 429);
  assert.deepStrictEqual(getBody(), { error: "too many requests", retry_after_ms: 3000 });
  assert.strictEqual(responseHeaders["X-RateLimit-Policy"], "login");
  assert.strictEqual(responseHeaders["X-RateLimit-Limit"], "5");
  assert.strictEqual(responseHeaders["Retry-After"], "3");
});

// Koa middleware tests

const { koaLimit, koaUse, koaIpKey, koaHeaderKey } = require("./dist/koa.js");

function createMockKoa(headers = {}, ip = "1.2.3.4") {
  const responseHeaders = {};
  const ctx = {
    ip,
    headers,
    get(name) {
      return headers[name.toLowerCase()] || "";
    },
    set(name, value) {
      responseHeaders[name] = value;
    },
    status: 200,
    body: null,
  };
  return { ctx, responseHeaders };
}

test("koaIpKey extracts IP", () => {
  const { ctx } = createMockKoa({}, "10.0.0.1");
  assert.strictEqual(koaIpKey(ctx), "ip:10.0.0.1");
});

test("koaHeaderKey reads specific header", () => {
  const keyFn = koaHeaderKey("X-API-Key");
  const { ctx } = createMockKoa({ "x-api-key": "abc" });
  assert.strictEqual(keyFn(ctx), "x-api-key:abc");
});

test("koaLimit allowed flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: true, remaining: 5 });

  const middleware = koaLimit(client, { max: 10, windowMs: 60000 });
  const { ctx, responseHeaders } = createMockKoa();

  let nextCalled = false;
  await middleware(ctx, async () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.strictEqual(ctx.status, 200);
  assert.strictEqual(responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(responseHeaders["X-RateLimit-Remaining"], "5");
});

test("koaLimit denied flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: false, remaining: 0, retry_after: 3000 });

  const middleware = koaLimit(client, { max: 10, windowMs: 60000 });
  const { ctx, responseHeaders } = createMockKoa();

  let nextCalled = false;
  await middleware(ctx, async () => { nextCalled = true; });

  assert.strictEqual(nextCalled, false);
  assert.strictEqual(ctx.status, 429);
  assert.deepStrictEqual(ctx.body, { error: "too many requests", retry_after_ms: 3000 });
  assert.strictEqual(responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(responseHeaders["X-RateLimit-Remaining"], "0");
  assert.strictEqual(responseHeaders["Retry-After"], "3");
});

test("koaUse applies local policy settings", async () => {
  const client = gobouncer({
    url: "http://localhost:8080",
    policies: {
      otpVerify: { algorithm: "sliding-window", limit: 5, windowMs: 60000 },
    },
  });

  let captured = null;
  client.check = async (key, max, windowMs, algorithm) => {
    captured = { key, max, windowMs, algorithm };
    return { allowed: true, remaining: 4 };
  };

  const middleware = koaUse(client, "otpVerify", {
    key: () => "user:42",
  });
  const { ctx } = createMockKoa();

  let nextCalled = false;
  await middleware(ctx, async () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(captured, {
    key: "ratelimit:otpVerify:sliding_window:user:42",
    max: 5,
    windowMs: 60000,
    algorithm: "sliding_window",
  });
});

// Next.js / Edge middleware tests

const { nextLimit, nextUse, nextIpKey, nextHeaderKey } = require("./dist/next.js");

function createMockRequest(headersMap = {}, ip = "1.2.3.4") {
  const headers = {
    get(name) {
      return headersMap[name.toLowerCase()] || null;
    }
  };
  return { headers, ip };
}

test("nextIpKey extracts IP", () => {
  const req = createMockRequest({ "x-forwarded-for": "10.0.0.1" });
  assert.strictEqual(nextIpKey(req), "ip:10.0.0.1");
});

test("nextHeaderKey reads specific header", () => {
  const keyFn = nextHeaderKey("X-API-Key");
  const req = createMockRequest({ "x-api-key": "abc" });
  assert.strictEqual(keyFn(req), "x-api-key:abc");
});

test("nextLimit allowed flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: true, remaining: 5 });

  const limit = nextLimit(client, { max: 10, windowMs: 60000 });
  const req = createMockRequest();

  const response = await limit(req);
  assert.strictEqual(response, null);
});

test("nextLimit denied flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: false, remaining: 0, retry_after: 3000 });

  const limit = nextLimit(client, { max: 10, windowMs: 60000 });
  const req = createMockRequest();

  const response = await limit(req);
  assert.ok(response instanceof globalThis.Response);
  assert.strictEqual(response.status, 429);

  const headers = response.headers;
  assert.strictEqual(headers.get("X-RateLimit-Limit"), "10");
  assert.strictEqual(headers.get("X-RateLimit-Remaining"), "0");
  assert.strictEqual(headers.get("Retry-After"), "3");
  assert.ok(headers.get("X-RateLimit-Reset"));

  const body = await response.json();
  assert.deepStrictEqual(body, { error: "too many requests", retry_after_ms: 3000 });
});

test("nextUse falls back to server-side named policy", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.checkPolicy = async (key, policy) => ({
    allowed: false,
    remaining: 0,
    retry_after: 3000,
    policy,
    limit: 5,
  });

  const limit = nextUse(client, "login");
  const response = await limit(createMockRequest());

  assert.ok(response instanceof globalThis.Response);
  assert.strictEqual(response.status, 429);
  assert.strictEqual(response.headers.get("X-RateLimit-Policy"), "login");
  assert.strictEqual(response.headers.get("X-RateLimit-Limit"), "5");
});

// Elysia plugin tests

const { elysiaLimit, elysiaUse, elysiaIpKey, elysiaHeaderKey } = require("./dist/elysia.js");

function createMockElysia(headersMap = {}, ip = "1.2.3.4") {
  const responseHeaders = {};
  const ctx = {
    request: {
      headers: {
        get(name) {
          return headersMap[name.toLowerCase()] || null;
        }
      }
    },
    set: {
      headers: responseHeaders,
      status: 200,
    },
    ip,
  };
  return { ctx, responseHeaders };
}

test("elysiaIpKey extracts IP", () => {
  const { ctx } = createMockElysia({ "x-forwarded-for": "10.0.0.1" });
  assert.strictEqual(elysiaIpKey(ctx), "ip:10.0.0.1");
});

test("elysiaHeaderKey reads specific header", () => {
  const keyFn = elysiaHeaderKey("X-API-Key");
  const { ctx } = createMockElysia({ "x-api-key": "abc" });
  assert.strictEqual(keyFn(ctx), "x-api-key:abc");
});

test("elysiaLimit allowed flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: true, remaining: 5 });

  const hook = elysiaLimit(client, { max: 10, windowMs: 60000 });
  const { ctx, responseHeaders } = createMockElysia();

  const response = await hook(ctx);

  assert.strictEqual(response, undefined);
  assert.strictEqual(ctx.set.status, 200);
  assert.strictEqual(responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(responseHeaders["X-RateLimit-Remaining"], "5");
});

test("elysiaLimit denied flow", async () => {
  const client = gobouncer({ url: "http://localhost:8080" });
  client.check = async () => ({ allowed: false, remaining: 0, retry_after: 3000 });

  const hook = elysiaLimit(client, { max: 10, windowMs: 60000 });
  const { ctx, responseHeaders } = createMockElysia();

  const response = await hook(ctx);

  assert.deepStrictEqual(response, { error: "too many requests", retry_after_ms: 3000 });
  assert.strictEqual(ctx.set.status, 429);
  assert.strictEqual(responseHeaders["X-RateLimit-Limit"], "10");
  assert.strictEqual(responseHeaders["X-RateLimit-Remaining"], "0");
  assert.strictEqual(responseHeaders["Retry-After"], "3");
  assert.ok(responseHeaders["X-RateLimit-Reset"]);
});

test("elysiaUse applies local policy settings", async () => {
  const client = gobouncer({
    url: "http://localhost:8080",
    policies: {
      profileRead: { algorithm: "gcra", limit: 100, windowMs: 60000 },
    },
  });

  let captured = null;
  client.check = async (key, max, windowMs, algorithm) => {
    captured = { key, max, windowMs, algorithm };
    return { allowed: true, remaining: 99 };
  };

  const hook = elysiaUse(client, "profileRead", {
    key: () => "user:42",
  });
  const { ctx } = createMockElysia();

  const response = await hook(ctx);

  assert.strictEqual(response, undefined);
  assert.deepStrictEqual(captured, {
    key: "ratelimit:profileRead:gcra:user:42",
    max: 100,
    windowMs: 60000,
    algorithm: "gcra",
  });
});
