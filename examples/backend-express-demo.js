import express from "express";
import { gobouncer, headerKey } from "gobouncer";

const app = express();

app.set("trust proxy", true);
app.use(express.json());

const limiter = gobouncer({
  url: process.env.GOBOUNCER_URL ?? "http://localhost:8080",
  timeoutMs: 150,
  failOpen: true,
  apiKey: process.env.GOBOUNCER_API_KEY,
  onError: (err) => {
    console.warn("GoBouncer error:", err.message);
  },
});

function clientIp(req) {
  return req.ip ?? req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? "unknown";
}

function userId(req) {
  return req.headers["x-user-id"] ?? req.body?.userId ?? "anon";
}

// Without named policy: inline limit/window/algorithm from the npm package.
app.use(
  "/api",
  limiter.limit({
    max: 100,
    windowMs: 60_000,
    key: (req) => `ip:${clientIp(req)}`,
  })
);

// With named policy from GoBouncer service: "login" is configured in policies.example.json.
app.post(
  "/otp",
  limiter.policy({
    name: "login",
    key: (req) => `otp:${clientIp(req)}:${req.body?.phone ?? "unknown"}`,
  }),
  (req, res) => {
    res.json({ ok: true, message: "OTP sent" });
  }
);

app.post(
  "/login",
  limiter.policy({
    name: "login-route",
    key: (req) => `route:/login:ip:${clientIp(req)}`,
  }),
  (req, res) => {
    res.json({ ok: true, token: "demo-token" });
  }
);

app.get(
  "/dashboard",
  limiter.limit({
    max: 60,
    windowMs: 60_000,
    key: (req) => `user:${userId(req)}`,
    algorithm: "sliding_window",
  }),
  (req, res) => {
    res.json({ ok: true, page: "dashboard" });
  }
);

app.post(
  "/payment",
  limiter.limit({
    max: 3,
    windowMs: 60_000,
    key: headerKey("Idempotency-Key"),
    algorithm: "gcra",
  }),
  (req, res) => {
    res.json({ ok: true, status: "payment accepted" });
  }
);

app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    gobouncerOnline: await limiter.ping(),
  });
});

app.listen(3000, () => {
  console.log("Backend listening on http://localhost:3000");
});
