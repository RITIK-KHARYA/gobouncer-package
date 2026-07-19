import asyncio

import httpx

from gobouncer import AsyncGoBouncerClient


def test_async_check_posts_inline_limit_payload():
    async def run():
        async def handler(request):
            assert request.url.path == "/check"
            assert request.headers.get("X-GoBouncer-Key") == "secret"
            return httpx.Response(200, json={"allowed": True, "remaining": 2})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
            client = AsyncGoBouncerClient(
                "http://localhost:8080",
                api_key="secret",
                client=http_client,
            )

            return await client.check("user:42", limit=5, window_ms=60_000)

    assert asyncio.run(run()) == {"allowed": True, "remaining": 2}
