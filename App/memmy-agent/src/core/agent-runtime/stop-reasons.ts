export const ACCEPTANCE_BLOCKED_STOP_REASON = "acceptance_blocked";

const FAILED_STOP_REASONS = new Set([
  "error",
  "toolError",
  ACCEPTANCE_BLOCKED_STOP_REASON,
]);

export function isFailedStopReason(value: string | null | undefined): boolean {
  return Boolean(value && FAILED_STOP_REASONS.has(value));
}
