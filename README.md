# gobouncer

Drop-in rate limiting middleware for Node.js, backed by the [GoBouncer](https://github.com/ritik-kharya/gobouncer) Go service.

GoBouncer itself runs as a small, fast Go service backed by Redis. This package is a thin client — it does no rate limiting math itself, it just talks to your running GoBouncer instance over HTTP and gives you an Express-style middleware.

## Install

```bash
npm install gobouncer
```

Requires Node.js 18+ (uses the built-in `fetch`).

## Quick start

```ts
import express from 'express'
import { gobouncer } from 'gobouncer'

const app = express()

// Create once, reuse everywhere
const limiter = gobouncer({ url: 'http://localhost:8080' })

// Apply globally — 100 requests per minute per IP
app.use(limiter.limit({ max: 100, windowMs: 60_000 }))

// Stricter limit on a sensitive route
app.post('/login', limiter.limit({ max: 5, windowMs: 60_000 }), loginHandler)

// Limit by authenticated user instead of IP
app.post(
  '/api/ai/generate',
  limiter.limit({
    max: 10,
    windowMs: 60_000,
    key: (req) => `user:${req.user.id}`,
    algorithm: 'gcra',
  }),
  generateHandler
)

app.listen(3000)
```

## API

### `gobouncer(options)`

Creates a client.

| Option      | Type      | Default          | Description                                            |
| ----------- | --------- | ---------------- | -------------------------------------------------------- |
| `url`       | `string`  | —                | Base URL of your running GoBouncer service              |
| `timeoutMs` | `number`  | `150`            | Max time to wait for a response                          |
| `failOpen`  | `boolean` | `true`           | Allow requests through if GoBouncer is unreachable        |
| `apiKey`    | `string`  | —                | Optional shared secret sent as `X-GoBouncer-Key`         |
| `onError`   | `function` | —               | Optional `(err: Error) => void` triggered on failures    |

### `limiter.limit(options)`

Returns an Express-style middleware `(req, res, next) => void`.

| Option      | Type                  | Default            | Description                                  |
| ----------- | --------------------- | ------------------- | --------------------------------------------- |
| `max`       | `number`              | —                    | Max requests allowed per window               |
| `windowMs`  | `number`              | —                    | Window size in milliseconds                   |
| `key`       | `(req) => string`     | limits by client IP | How to identify the caller                    |
| `algorithm` | `'sliding_window'` \| `'gcra'` | `'sliding_window'`  | Which algorithm GoBouncer should use          |

The middleware automatically sets standard rate-limiting headers on every response:
- `X-RateLimit-Limit`: The `max` limit configured.
- `X-RateLimit-Remaining`: How many requests are left in the current window.
- `X-RateLimit-Reset`: Unix timestamp in seconds indicating when the window resets (when `retry_after` info is available).

If the limit is exceeded, it intercepts the request, sets a `Retry-After` header (in seconds), and returns a `429 Too Many Requests` status with a JSON body:
```json
{
  "error": "too many requests",
  "retry_after_ms": 5000
}
```

### `limiter.ping()`

Checks connection to the GoBouncer service. Sends a request to `/health` (falling back to `/`) and returns a `Promise<boolean>` indicating whether the service is reachable.

```ts
const isOnline = await limiter.ping()
if (!isOnline) {
  console.warn("GoBouncer service is offline!")
}
```

### `limiter.check(key, max, windowMs, algorithm?)`

Call GoBouncer directly without the middleware wrapper — useful for protecting non-HTTP code paths, like before enqueuing a BullMQ job:

```ts
const result = await limiter.check(`enqueue:${userId}`, 10, 60_000)
if (!result.allowed) {
  throw new Error(`queue limit reached, retry in ${result.retry_after}ms`)
}
await emailQueue.add('send', jobData)
```

### Built-in key helpers

```ts
import { ipKey, headerKey } from 'gobouncer'

limiter.limit({ max: 100, windowMs: 60_000, key: ipKey })
limiter.limit({ max: 100, windowMs: 60_000, key: headerKey('X-API-Key') })
```

## Behaviour when GoBouncer is unreachable

By default (`failOpen: true`), requests pass through if GoBouncer can't be reached within `timeoutMs`. This means a GoBouncer outage degrades your app to "no rate limiting" instead of "app is down." Set `failOpen: false` if strict enforcement matters more than availability for your use case.

---

## Hono.js

The package ships a dedicated Hono adapter via the `gobouncer/hono` sub-path export. No extra dependencies — Hono is an optional peer dependency.

### Quick start (Hono)

```ts
import { Hono } from 'hono'
import { gobouncer } from 'gobouncer'
import { honoLimit } from 'gobouncer/hono'

const app = new Hono()

const limiter = gobouncer({ url: 'http://localhost:8080' })

// Global — 100 requests per minute per IP
app.use('*', honoLimit(limiter, { max: 100, windowMs: 60_000 }))

// Stricter limit on a sensitive route
app.post('/login', honoLimit(limiter, { max: 5, windowMs: 60_000 }), loginHandler)

// Limit by a custom header
import { honoHeaderKey } from 'gobouncer/hono'

app.use(
  '/api/*',
  honoLimit(limiter, {
    max: 50,
    windowMs: 60_000,
    key: honoHeaderKey('X-API-Key'),
  })
)

// Limit by authenticated user
app.post(
  '/api/ai/generate',
  honoLimit(limiter, {
    max: 10,
    windowMs: 60_000,
    key: (c) => `user:${c.req.header('x-user-id') ?? 'anon'}`,
    algorithm: 'gcra',
  }),
  generateHandler
)

export default app
```

### `honoLimit(client, options)`

Returns a Hono-compatible middleware `MiddlewareHandler`.

| Option      | Type                  | Default            | Description                                  |
| ----------- | --------------------- | ------------------- | --------------------------------------------- |
| `max`       | `number`              | —                    | Max requests allowed per window               |
| `windowMs`  | `number`              | —                    | Window size in milliseconds                   |
| `key`       | `(c: Context) => string` | limits by client IP | How to identify the caller                |
| `algorithm` | `'sliding_window'` \| `'gcra'` | `'sliding_window'`  | Which algorithm GoBouncer should use  |

### Hono key helpers

```ts
import { honoIpKey, honoHeaderKey } from 'gobouncer/hono'

honoLimit(limiter, { max: 100, windowMs: 60_000, key: honoIpKey })
honoLimit(limiter, { max: 100, windowMs: 60_000, key: honoHeaderKey('X-API-Key') })
```

- **`honoIpKey(c)`** — reads `x-forwarded-for` → `x-real-ip` → `'unknown'`
- **`honoHeaderKey(headerName)`** — reads the given header, falls back to `honoIpKey`

---

## Fastify

```ts
import { fastifyLimit } from 'gobouncer/fastify'

fastify.get('/api', {
  preHandler: fastifyLimit(limiter, { max: 100, windowMs: 60_000 })
}, handler)
```

## Koa

```ts
import { koaLimit } from 'gobouncer/koa'

app.use(koaLimit(limiter, { max: 100, windowMs: 60_000 }))
```

## Next.js / Edge middleware

Returns a blocked response (429) if the limit is exceeded, or `null` if allowed.

```ts
import { nextLimit } from 'gobouncer/next'

const limit = nextLimit(limiter, { max: 100, windowMs: 60_000 })

export async function middleware(req: Request) {
  const blockedResponse = await limit(req)
  if (blockedResponse) return blockedResponse
  return NextResponse.next()
}
```

## Elysia

```ts
import { elysiaLimit } from 'gobouncer/elysia'

new Elysia().get('/api', () => 'hi', {
  beforeHandle: elysiaLimit(limiter, { max: 100, windowMs: 60_000 })
})
```

---

## License

MIT

