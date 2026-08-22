import type { Request, Response } from "express";

/**
 * Backend-enforced typed confirmation for destructive admin actions.
 * Compares `body.confirmation` to `expected` (trim, exact, case-sensitive).
 * On mismatch: 400 with `expectedHint` (never echoes the submitted value).
 * Returns true when confirmation matches; false after sending the error response.
 */
export function requireTypedConfirmation(
  req: Request,
  res: Response,
  expected: string,
): boolean {
  const body = (req.body ?? {}) as { confirmation?: unknown };
  const submitted =
    typeof body.confirmation === "string" ? body.confirmation.trim() : "";

  if (submitted !== expected) {
    res.status(400).json({
      error: "Typed confirmation required",
      expectedHint: `Type exactly: ${expected}`,
    });
    return false;
  }
  return true;
}

/** Fixed phrases for platform-wide destructive admin actions. */
export const CONFIRM_CLOSE_ALL_POSITIONS = "CLOSE ALL POSITIONS";
export const CONFIRM_SYNC_ALL_FOLLOWERS = "SYNC ALL FOLLOWERS";
export const CONFIRM_CLEAR_DUMMY_TRADES = "CLEAR DUMMY TRADES";
export const CONFIRM_INJECT_TEST_TRADE = "INJECT TEST TRADE";
