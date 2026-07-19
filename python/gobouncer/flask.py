from __future__ import annotations

from collections.abc import Callable
from functools import wraps
from typing import Any

from .client import GoBouncerClient
from .types import PolicyAlgorithm
from .utils import namespaced_policy_key, normalize_algorithm


def ip_key() -> str:
    try:
        from flask import request
    except ImportError as exc:
        raise ImportError("Install Flask support with `pip install gobouncer[flask]`.") from exc

    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return f"ip:{forwarded.split(',')[0].strip()}"
    return f"ip:{request.remote_addr or 'unknown'}"


def rate_limited(
    client: GoBouncerClient,
    *,
    policy_name: str,
    limit: int | None = None,
    window_ms: int | None = None,
    algorithm: PolicyAlgorithm = "sliding_window",
    key: Callable[[], str] = ip_key,
    server_side_policy: bool = False,
):
    try:
        from flask import jsonify
    except ImportError as exc:
        raise ImportError("Install Flask support with `pip install gobouncer[flask]`.") from exc

    def decorator(handler: Callable[..., Any]):
        @wraps(handler)
        def wrapper(*args: Any, **kwargs: Any):
            raw_key = key()

            if server_side_policy:
                result = client.check_policy(raw_key, policy_name)
            else:
                if limit is None or window_ms is None:
                    raise ValueError("limit and window_ms are required for app-side policies")
                normalized = normalize_algorithm(algorithm)
                result = client.check(
                    namespaced_policy_key(policy_name, normalized, raw_key),
                    limit=limit,
                    window_ms=window_ms,
                    algorithm=normalized,
                )

            if not result.get("allowed"):
                return jsonify(
                    {
                        "error": "too many requests",
                        "retry_after_ms": result.get("retry_after", 0),
                    }
                ), 429

            return handler(*args, **kwargs)

        return wrapper

    return decorator
