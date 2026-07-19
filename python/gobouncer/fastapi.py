from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .client import AsyncGoBouncerClient
from .types import PolicyAlgorithm
from .utils import namespaced_policy_key, normalize_algorithm


def ip_key(request: Any) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return f"ip:{forwarded.split(',')[0].strip()}"
    host = request.client.host if getattr(request, "client", None) else "unknown"
    return f"ip:{host}"


def rate_limit_dependency(
    client: AsyncGoBouncerClient,
    *,
    policy_name: str,
    limit: int | None = None,
    window_ms: int | None = None,
    algorithm: PolicyAlgorithm = "sliding_window",
    key: Callable[[Any], str] = ip_key,
    server_side_policy: bool = False,
):
    try:
        from fastapi import HTTPException, Request
    except ImportError as exc:
        raise ImportError("Install FastAPI support with `pip install gobouncer[fastapi]`.") from exc

    async def dependency(request: Request) -> None:
        raw_key = key(request)

        if server_side_policy:
            result = await client.check_policy(raw_key, policy_name)
        else:
            if limit is None or window_ms is None:
                raise ValueError("limit and window_ms are required for app-side policies")
            normalized = normalize_algorithm(algorithm)
            result = await client.check(
                namespaced_policy_key(policy_name, normalized, raw_key),
                limit=limit,
                window_ms=window_ms,
                algorithm=normalized,
            )

        if not result.get("allowed"):
            raise HTTPException(
                status_code=429,
                detail={
                    "error": "too many requests",
                    "retry_after_ms": result.get("retry_after", 0),
                },
            )

    return dependency
