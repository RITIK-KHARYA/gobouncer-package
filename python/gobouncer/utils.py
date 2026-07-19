from .types import Algorithm, PolicyAlgorithm


def normalize_algorithm(algorithm: PolicyAlgorithm | None = None) -> Algorithm:
    if algorithm in (None, "sliding-window", "sliding_window"):
        return "sliding_window"
    return algorithm


def namespaced_policy_key(policy_name: str, algorithm: PolicyAlgorithm, key: str) -> str:
    normalized = normalize_algorithm(algorithm)
    return f"ratelimit:{policy_name}:{normalized}:{key}"
