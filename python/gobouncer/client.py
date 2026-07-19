from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

import httpx

from .types import CheckResult, PolicyAlgorithm
from .utils import normalize_algorithm

ErrorHandler = Callable[[Exception], None]


class GoBouncerClient:
    def __init__(
        self,
        url: str,
        *,
        timeout: float = 0.15,
        fail_open: bool = True,
        api_key: str | None = None,
        on_error: ErrorHandler | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.fail_open = fail_open
        self.api_key = api_key
        self.on_error = on_error
        self._client = client

    def check(
        self,
        key: str,
        *,
        limit: int,
        window_ms: int,
        algorithm: PolicyAlgorithm = "sliding_window",
    ) -> CheckResult:
        return self._send_check(
            {
                "key": key,
                "limit": limit,
                "window_ms": window_ms,
                "algorithm": normalize_algorithm(algorithm),
            }
        )

    def check_policy(self, key: str, policy: str) -> CheckResult:
        return self._send_check({"key": key, "policy": policy})

    def ping(self) -> bool:
        try:
            response = self._request("GET", "/health")
            if response.is_success:
                return True
            return self._request("GET", "/").is_success
        except Exception:
            return False

    def _send_check(self, body: Mapping[str, Any]) -> CheckResult:
        try:
            response = self._request("POST", "/check", json=dict(body))
            response.raise_for_status()
            result = response.json()

            limit_header = response.headers.get("X-RateLimit-Limit")
            policy_header = response.headers.get("X-RateLimit-Policy")
            if limit_header and str(limit_header).isdigit():
                result["limit"] = int(limit_header)
            if policy_header:
                result["policy"] = policy_header

            return result
        except Exception as exc:
            self._handle_error(exc)
            return self._fallback()

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.setdefault("Content-Type", "application/json")
        if self.api_key:
            headers["X-GoBouncer-Key"] = self.api_key

        if self._client:
            return self._client.request(method, f"{self.url}{path}", headers=headers, **kwargs)

        with httpx.Client(timeout=self.timeout) as client:
            return client.request(method, f"{self.url}{path}", headers=headers, **kwargs)

    def _fallback(self) -> CheckResult:
        if self.fail_open:
            return {"allowed": True, "remaining": -1}
        return {"allowed": False, "remaining": 0, "retry_after": 0}

    def _handle_error(self, exc: Exception) -> None:
        if not self.on_error:
            return
        try:
            self.on_error(exc)
        except Exception:
            pass


class AsyncGoBouncerClient:
    def __init__(
        self,
        url: str,
        *,
        timeout: float = 0.15,
        fail_open: bool = True,
        api_key: str | None = None,
        on_error: ErrorHandler | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.fail_open = fail_open
        self.api_key = api_key
        self.on_error = on_error
        self._client = client

    async def check(
        self,
        key: str,
        *,
        limit: int,
        window_ms: int,
        algorithm: PolicyAlgorithm = "sliding_window",
    ) -> CheckResult:
        return await self._send_check(
            {
                "key": key,
                "limit": limit,
                "window_ms": window_ms,
                "algorithm": normalize_algorithm(algorithm),
            }
        )

    async def check_policy(self, key: str, policy: str) -> CheckResult:
        return await self._send_check({"key": key, "policy": policy})

    async def ping(self) -> bool:
        try:
            response = await self._request("GET", "/health")
            if response.is_success:
                return True
            return (await self._request("GET", "/")).is_success
        except Exception:
            return False

    async def _send_check(self, body: Mapping[str, Any]) -> CheckResult:
        try:
            response = await self._request("POST", "/check", json=dict(body))
            response.raise_for_status()
            result = response.json()

            limit_header = response.headers.get("X-RateLimit-Limit")
            policy_header = response.headers.get("X-RateLimit-Policy")
            if limit_header and str(limit_header).isdigit():
                result["limit"] = int(limit_header)
            if policy_header:
                result["policy"] = policy_header

            return result
        except Exception as exc:
            self._handle_error(exc)
            return self._fallback()

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.setdefault("Content-Type", "application/json")
        if self.api_key:
            headers["X-GoBouncer-Key"] = self.api_key

        if self._client:
            return await self._client.request(method, f"{self.url}{path}", headers=headers, **kwargs)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            return await client.request(method, f"{self.url}{path}", headers=headers, **kwargs)

    def _fallback(self) -> CheckResult:
        if self.fail_open:
            return {"allowed": True, "remaining": -1}
        return {"allowed": False, "remaining": 0, "retry_after": 0}

    def _handle_error(self, exc: Exception) -> None:
        if not self.on_error:
            return
        try:
            self.on_error(exc)
        except Exception:
            pass
