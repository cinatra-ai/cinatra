// Typed VersionConflict error.
// Returned (thrown) on CAS-fail. No smart auto-merge. UI catches and
// presents the four explicit choices: keep-mine / keep-latest / abort /
// propose-merge (latter routes through the merge-proposal enrichment-agent
// pattern).

import type {
  CanonicalSnapshot,
  VersionConflictPayload,
  VersionConflictReason,
} from "./types";

export class VersionConflictError extends Error {
  readonly objectId: string;
  readonly currentVersion: number | null;
  readonly expectedBaseVersion: number | null;
  readonly latestSnapshot: CanonicalSnapshot | null;
  readonly conflictingFields: string[];
  readonly reason: VersionConflictReason;

  constructor(payload: VersionConflictPayload, message?: string) {
    super(
      message ??
        `VersionConflict (${payload.reason}): object=${payload.objectId} expected=${payload.expectedBaseVersion} current=${payload.currentVersion}`,
    );
    this.name = "VersionConflictError";
    this.objectId = payload.objectId;
    this.currentVersion = payload.currentVersion;
    this.expectedBaseVersion = payload.expectedBaseVersion;
    this.latestSnapshot = payload.latestSnapshot;
    this.conflictingFields = payload.conflictingFields;
    this.reason = payload.reason;
  }

  toPayload(): VersionConflictPayload {
    return {
      objectId: this.objectId,
      currentVersion: this.currentVersion,
      expectedBaseVersion: this.expectedBaseVersion,
      latestSnapshot: this.latestSnapshot,
      conflictingFields: this.conflictingFields,
      reason: this.reason,
    };
  }
}

export function isVersionConflictError(
  e: unknown,
): e is VersionConflictError {
  return e instanceof VersionConflictError;
}

export class HistoryWriterContractError extends Error {
  readonly code:
    | "missing-actor"
    | "missing-effect"
    | "missing-compensating-template"
    | "invalid-effect"
    | "missing-base-version"
    | "schema-version-disallowed";
  constructor(
    code: HistoryWriterContractError["code"],
    message: string,
  ) {
    super(message);
    this.name = "HistoryWriterContractError";
    this.code = code;
  }
}
