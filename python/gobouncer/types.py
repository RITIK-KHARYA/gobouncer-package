from typing import Literal, TypedDict


Algorithm = Literal["sliding_window", "gcra"]
PolicyAlgorithm = Literal["sliding_window", "sliding-window", "gcra"]


class CheckResult(TypedDict, total=False):
    key: str
    policy: str
    limit: int
    allowed: bool
    remaining: int
    retry_after: int
