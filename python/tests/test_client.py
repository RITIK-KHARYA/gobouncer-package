import json

import httpx

from gobouncer import GoBouncerClient, namespaced_policy_key


def test_check_posts_inline_limit_payload():
    captured = {}

    def handler(request):
        captured["json"] = json.loads(request.read())
        captured["api_key"] = request.headers.get("X-GoBouncer-Key")
        return httpx.Response(
            200,
            json={"allowed": True, "remaining": 9},
            headers={"X-RateLimit-Limit": "10"},
        )

    client = GoBouncerClient(
        "http://localhost:8080/",
        api_key="secret",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    result = client.check("ip:127.0.0.1", limit=10, window_ms=60_000, algorithm="sliding-window")

    assert result == {"allowed": True, "remaining": 9, "limit": 10}
    assert captured["api_key"] == "secret"
    assert captured["json"] == {
        "key": "ip:127.0.0.1",
        "limit": 10,
        "window_ms": 60_000,
        "algorithm": "sliding_window",
    }


def test_check_policy_posts_named_policy_payload():
    def handler(request):
        assert request.url.path == "/check"
        assert json.loads(request.read()) == {"key": "user:42", "policy": "login"}
        return httpx.Response(200, json={"allowed": True, "remaining": 4})

    client = GoBouncerClient(
        "http://localhost:8080",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert client.check_policy("user:42", "login") == {"allowed": True, "remaining": 4}


def test_fail_open_and_fail_closed():
    def handler(_request):
        raise httpx.ConnectError("down")

    fail_open = GoBouncerClient(
        "http://localhost:8080",
        fail_open=True,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    fail_closed = GoBouncerClient(
        "http://localhost:8080",
        fail_open=False,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert fail_open.check("ip:1", limit=1, window_ms=1000) == {"allowed": True, "remaining": -1}
    assert fail_closed.check("ip:1", limit=1, window_ms=1000) == {
        "allowed": False,
        "remaining": 0,
        "retry_after": 0,
    }


def test_namespaced_policy_key_normalizes_algorithm():
    assert namespaced_policy_key("otpVerify", "sliding-window", "user:42") == (
        "ratelimit:otpVerify:sliding_window:user:42"
    )
