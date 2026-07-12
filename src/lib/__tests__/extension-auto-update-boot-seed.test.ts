// Boot-seed behavior of the extension auto-update loop (cinatra#1042
// acceptance: "Flag OFF (default) → loop not scheduled (boot log assertion)").
//
// Drives the REAL `seed-extension-auto-update` phase from
// src/lib/boot/phases/system-loops.ts with its dynamic imports mocked:
//   - flag OFF/unset (the default): NO enqueue, NO runner registration, and
//     the "loop not seeded" boot log line;
//   - flag ON: registers the cycle runner FIRST, then seeds the canonical
//     dedup'd delayed job with the perpetual-loop options.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { enqueueMock, registerMock, runCycleMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(async () => undefined),
  registerMock: vi.fn(),
  runCycleMock: vi.fn(async () => ({})),
}));

vi.mock("@/lib/extension-auto-update", () => ({
  // The real flag semantics (only the literal "true" enables) — the module
  // itself is mocked so this leaf test does not load the update machinery.
  isExtensionAutoUpdateEnabled: () => process.env.CINATRA_EXTENSION_AUTO_UPDATE === "true",
  runExtensionAutoUpdateCycle: runCycleMock,
}));
vi.mock("@/lib/background-jobs-registry", () => ({
  registerExtensionAutoUpdateRunner: registerMock,
}));
vi.mock("@/lib/background-jobs", async () => {
  const names = await vi.importActual<typeof import("@/lib/background-jobs-names")>(
    "@/lib/background-jobs-names",
  );
  return {
    BACKGROUND_JOB_NAMES: names.BACKGROUND_JOB_NAMES,
    EXTENSION_AUTO_UPDATE_LOOP_JOB_ID: names.EXTENSION_AUTO_UPDATE_LOOP_JOB_ID,
    enqueueBackgroundJob: enqueueMock,
  };
});

import { systemLoopPhases } from "@/lib/boot/phases/system-loops";
import {
  BACKGROUND_JOB_NAMES,
  EXTENSION_AUTO_UPDATE_LOOP_JOB_ID,
} from "@/lib/background-jobs-names";

function seedPhase() {
  const phase = systemLoopPhases().find((p) => p.name === "seed-extension-auto-update");
  expect(phase).toBeDefined();
  return phase!;
}

const priorFlag = process.env.CINATRA_EXTENSION_AUTO_UPDATE;

beforeEach(() => {
  enqueueMock.mockClear();
  registerMock.mockClear();
  delete process.env.CINATRA_EXTENSION_AUTO_UPDATE;
});

afterEach(() => {
  if (priorFlag === undefined) delete process.env.CINATRA_EXTENSION_AUTO_UPDATE;
  else process.env.CINATRA_EXTENSION_AUTO_UPDATE = priorFlag;
});

describe("seed-extension-auto-update boot phase", () => {
  it("flag unset (the default) → loop NOT seeded: no enqueue, no runner, boot log says so", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await seedPhase().run();

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
    expect(
      log.mock.calls.some(
        (c) =>
          String(c[0]).includes("[extension-auto-update]") &&
          String(c[0]).includes("loop not seeded"),
      ),
    ).toBe(true);
    log.mockRestore();
  });

  it("flag set to a non-\"true\" value → still not seeded", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.CINATRA_EXTENSION_AUTO_UPDATE = "1";

    await seedPhase().run();

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("flag ON → registers the runner BEFORE seeding the canonical perpetual-loop job", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.CINATRA_EXTENSION_AUTO_UPDATE = "true";

    await seedPhase().run();

    // Runner registered (a thunk over runExtensionAutoUpdateCycle)…
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(runCycleMock).not.toHaveBeenCalled();
    const registered = registerMock.mock.calls[0][0] as () => Promise<unknown>;
    await registered();
    expect(runCycleMock).toHaveBeenCalledTimes(1);
    // …BEFORE the seed (the loop can never fire against an empty slot).
    expect(registerMock.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueMock.mock.invocationCallOrder[0],
    );

    // Canonical dedup'd delayed job with the perpetual-loop options.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      BACKGROUND_JOB_NAMES.EXTENSION_AUTO_UPDATE,
      {},
      {
        jobId: EXTENSION_AUTO_UPDATE_LOOP_JOB_ID,
        delay: 60 * 60 * 1000,
        overwriteIfStale: true,
        skipWorker: true,
        inheritActorContext: false,
      },
    );
    expect(
      log.mock.calls.some(
        (c) =>
          String(c[0]).includes("[extension-auto-update]") &&
          String(c[0]).includes("scheduled"),
      ),
    ).toBe(true);
    log.mockRestore();
  });
});
