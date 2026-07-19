// Typed errors for the auditor snapshot/receipt store (cinatra#1625). Kept in a
// server-free module so both the store and the API routes can map a code to an
// HTTP status without importing the DB layer.

export type AuditorSnapshotErrorCode =
  | "malformed_snapshot"
  | "snapshot_conflict"
  | "receipt_mint_failed";

export class AuditorSnapshotError extends Error {
  code: AuditorSnapshotErrorCode;
  constructor(code: AuditorSnapshotErrorCode, message: string) {
    super(message);
    this.name = "AuditorSnapshotError";
    this.code = code;
  }
}

export function auditorApprovalSnapshotError(
  code: AuditorSnapshotErrorCode,
  message: string,
): AuditorSnapshotError {
  return new AuditorSnapshotError(code, message);
}
