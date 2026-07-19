import type { Algorithm, PolicyDefinition } from "./types";

export function normalizePolicyAlgorithm(
  algorithm: PolicyDefinition["algorithm"]
): Algorithm {
  return algorithm === "sliding-window"
    ? "sliding_window"
    : algorithm ?? "sliding_window";
}

export function namespacedPolicyKey(
  policyName: string,
  algorithm: Algorithm,
  key: string
): string {
  return `ratelimit:${policyName}:${algorithm}:${key}`;
}
