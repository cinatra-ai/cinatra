import { vi } from "vitest";

/** cinatra#4245: a pause claim that always wins, for tests about something else on a
 * resume road. The claim's own rules are proven against a real database in
 * run-pause-claim.integration.test.ts. */
export const pauseClaimFake = {
  claimPause: vi.fn(async () => ({ kind: "claimed", token: "tok-fake", generation: 1, expiresAt: new Date(0) })),
  fencePauseInPlace: vi.fn(async () => "fenced"),
  releasePauseClaim: vi.fn(async () => "released"),
  settlePauseSend: vi.fn(async () => "settled"),
};
