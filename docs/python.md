# Using GoBouncer from Python

This repository ships a Python client for the GoBouncer service. Python backends can use it directly with FastAPI, Flask, Django, Litestar, or any other Python framework.

## Support Level

- `npm install gobouncer` is for Node.js, Express, Hono, Fastify, Koa, Next.js, and Elysia.
- `pip install gobouncer` is for Python, after the Python package is published to PyPI.
- During development, Python users can install this repository with `pip install -e .`.
- Python and Node clients both call the same GoBouncer HTTP service.

## Install

From PyPI, after publishing:

```bash
pip install gobouncer
```

From this repository during development:

```bash
pip install -e .
```

Optional framework helpers:

```bash
pip install "gobouncer[fastapi]"
pip install "gobouncer[flask]"
pip install "gobouncer[django]"
```

## Basic Client

```py
from gobouncer import AsyncGoBouncerClient, GoBouncerClient, namespaced_policy_key


client = GoBouncerClient("http://localhost:8080")

result = client.check(
    namespaced_policy_key("login", "sliding_window", "ip:127.0.0.1"),
    limit=10,
    window_ms=60_000,
)

if result["allowed"]:
    print("request can continue")


async_client = AsyncGoBouncerClient("http://localhost:8080")
async_result = await async_client.check_policy("user:42", "otpVerify")
```

## FastAPI Example

```py
from fastapi import Depends, FastAPI
from gobouncer import AsyncGoBouncerClient
from gobouncer.fastapi import rate_limit_dependency


app = FastAPI()
client = AsyncGoBouncerClient("http://localhost:8080")

otp_limit = rate_limit_dependency(
    client,
    policy_name="otpVerify",
    limit=5,
    window_ms=60_000,
    algorithm="sliding_window",
)


@app.post("/otp", dependencies=[Depends(otp_limit)])
async def otp():
    return {"ok": True}
```

## Flask Example

```py
from flask import Flask, jsonify
from gobouncer import GoBouncerClient
from gobouncer.flask import rate_limited


app = Flask(__name__)
client = GoBouncerClient("http://localhost:8080")


@app.post("/login")
@rate_limited(client, policy_name="login", limit=10, window_ms=60_000)
def login():
    return jsonify({"ok": True})
```

## Django Example

```py
from django.http import JsonResponse
from gobouncer import GoBouncerClient
from gobouncer.django import rate_limited


client = GoBouncerClient("http://localhost:8080")


@rate_limited(client, policy_name="paymentCreate", limit=3, window_ms=60_000, algorithm="gcra")
def payment(request):
    return JsonResponse({"ok": True})
```

## Server-Side Policy Example

If your policies are configured inside the GoBouncer service, Python only needs to send `key` and `policy`:

```py
result = await async_client.check_policy("user:42", "otpVerify")
```

For server-side policies, the GoBouncer service should namespace Redis keys internally, for example:

```text
ratelimit:{policyName}:{algorithm}:{key}
```

For app-side policies in Python, `namespaced_policy_key(...)` and the framework helpers namespace the key before sending it.
