// Test stub for the host-app per-claim activation gate
// (src/lib/objects/claim-activation-gate.ts). The real module imports
// server-only + postgres reads; it is not initialised in the packages/objects
// vitest sandbox. The objects_save / objects_update handlers import
// `assertActivatedTypePayloadValid` + `typeHasActiveDedicatedClaim` at top
// level, so this stub makes the specifier resolve with SAFE sandbox defaults:
//   - typeHasActiveDedicatedClaim → false (no claim registry in the sandbox),
//     so the enforcement helper is a no-op for existing handler tests;
//   - assertActivatedTypePayloadValid → the REAL pure logic (no DB), so a
//     behaviour test can `vi.mock("@/lib/objects/claim-activation-gate", …)`
//     the claim probe to `true` and still exercise real rejection.
// Kept a byte-for-byte mirror of the real pure function (no DB dependency).

export class InvalidActivatedTypePayloadError extends Error {
  constructor(
    public readonly objectTypeId: string,
    public readonly detail?: string,
  ) {
    super(
      `invalid payload for activated type '${objectTypeId}': it does not satisfy the registered schema${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "InvalidActivatedTypePayloadError";
  }
}

export function typeHasActiveDedicatedClaim(_orgId: string, _objectTypeId: string): boolean {
  return false;
}

export function assertActivatedTypePayloadValid(input: {
  objectTypeId: string;
  data: unknown;
  hasActiveClaim: boolean;
  validate: ((data: unknown) => boolean) | null;
  detail?: string;
}): void {
  if (!input.hasActiveClaim || input.validate == null) return;
  let ok = false;
  try {
    ok = input.validate(input.data);
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new InvalidActivatedTypePayloadError(input.objectTypeId, input.detail);
  }
}
