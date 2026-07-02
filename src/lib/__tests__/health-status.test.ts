import { describe, expect, it } from "vitest";

import { deriveHealthStatus } from "@/lib/boot/health-status";
import type { BootStateSnapshot } from "@/lib/boot/boot-state";

// ---------------------------------------------------------------------------
// Health-status derivation (cinatra#789 item 1). The top-level `status` + HTTP code
// must reflect readiness so a deploy health gate REJECTS a not-ready / durably-degraded
// boot, while a self-healing (retryable-only) degradation stays health-passing.
// ---------------------------------------------------------------------------

function snap(over: Partial<BootStateSnapshot>): BootStateSnapshot {
  return {
    scope: "process-local",
    readiness: "ready",
    startedAt: 1,
    readyAt: 2,
    phases: [],
    degradedPhases: [],
    blockingPhases: [],
    ...over,
  };
}

describe("deriveHealthStatus", () => {
  it("ready -> ok / 200", () => {
    const d = deriveHealthStatus(snap({ readiness: "ready" }));
    expect(d).toEqual({ status: "ok", httpStatus: 200, degraded: false });
  });

  it("booting -> starting / 503 (not yet ready)", () => {
    const d = deriveHealthStatus(snap({ readiness: "booting", readyAt: null }));
    expect(d.status).toBe("starting");
    expect(d.httpStatus).toBe(503);
  });

  it("failed -> error / 503", () => {
    const d = deriveHealthStatus(
      snap({ readiness: "failed", fatalPhase: "core-migrations", readyAt: null }),
    );
    expect(d.status).toBe("error");
    expect(d.httpStatus).toBe(503);
  });

  it("degraded with a DURABLE degraded-policy failure -> degraded / 503 (deploy-blocking)", () => {
    const d = deriveHealthStatus(
      snap({
        readiness: "degraded",
        degradedPhases: ["boot-degrade-probe"],
        blockingPhases: ["boot-degrade-probe"],
      }),
    );
    expect(d.status).toBe("degraded");
    expect(d.httpStatus).toBe(503);
    expect(d.degraded).toBe(true);
  });

  it("degraded with ONLY retryable failures -> ok / 200 but degraded:true (self-healing, NOT blocking)", () => {
    const d = deriveHealthStatus(
      snap({
        readiness: "degraded",
        degradedPhases: ["cache-warmup", "user-store-mount-check"],
        blockingPhases: [],
      }),
    );
    expect(d.status).toBe("ok");
    expect(d.httpStatus).toBe(200);
    expect(d.degraded).toBe(true);
  });
});
