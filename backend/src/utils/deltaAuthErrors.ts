import axios from "axios";

/** Follower/master Delta REST auth failed — must not treat as zero open positions. */
export class DeltaInvalidCredentialsError extends Error {
  readonly code = "invalid_api_key" as const;

  constructor(message = "Invalid Delta API credentials") {
    super(message);
    this.name = "DeltaInvalidCredentialsError";
  }
}

function payloadIndicatesInvalidApiKey(payload: unknown): boolean {
  if (payload == null) return false;
  if (typeof payload === "string") {
    return /invalid_api_key/i.test(payload);
  }
  if (typeof payload !== "object") return false;

  const row = payload as Record<string, unknown>;
  const code = String(row.code ?? row.error_code ?? "").toLowerCase();
  if (code === "invalid_api_key" || code.includes("invalid_api_key")) {
    return true;
  }
  const msg = String(row.message ?? row.msg ?? "");
  return /invalid_api_key/i.test(msg);
}

export function isDeltaInvalidCredentialsError(err: unknown): boolean {
  if (err instanceof DeltaInvalidCredentialsError) return true;

  if (axios.isAxiosError(err)) {
    if (err.response?.status === 401) return true;
    if (payloadIndicatesInvalidApiKey(err.response?.data)) return true;
  }

  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/invalid_api_key/i.test(msg)) return true;
  if (/"code"\s*:\s*"invalid_api_key"/i.test(msg)) return true;
  return false;
}

export function toDeltaInvalidCredentialsError(
  err: unknown,
): DeltaInvalidCredentialsError {
  if (err instanceof DeltaInvalidCredentialsError) return err;
  const msg =
    err instanceof Error ? err.message : String(err ?? "Invalid Delta API credentials");
  return new DeltaInvalidCredentialsError(msg);
}

export function logFollowerSkippedInvalidApiKey(
  userId: string,
  context: string,
): void {
  console.warn(
    `[copy] User ${userId} skipped during sync due to Invalid API Key (${context})`,
  );
}
