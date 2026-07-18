// Generator emission of the RAW `cinatra.execution.environment` pass-through
// onto NormalizedExtensionRecord (exec-plane S3, cinatra#1708). Pins the
// CARRIER-KIND gate + the raw pass-through (validation is a CONSUMPTION
// concern — the execution plane parses fail-closed via
// parseExecutionEnvironment), and PARITY with the sdk leaf's
// resolveExecutionEnvironmentClaim so the generator and the runtime-loader
// path can never drift.
import { describe, it, expect } from "vitest";
import { resolveExecutionEnvironmentClaim } from "../generate-extension-manifest.mjs";
import { resolveExecutionEnvironmentClaim as sdkResolve } from "../../../packages/sdk-extensions/src/execution-environment";

const ENV = { pip: ["pandas==2.2.1"], npm: ["prettier"] };

describe("resolveExecutionEnvironmentClaim — generator emission", () => {
  it("emits the RAW claim on kind:agent (carried UNVALIDATED)", () => {
    expect(
      resolveExecutionEnvironmentClaim("agent", { execution: { environment: ENV } }),
    ).toBe(ENV);
  });

  it("emits null ONLY when the agent genuinely declares nothing", () => {
    expect(resolveExecutionEnvironmentClaim("agent", {})).toBeNull();
    expect(resolveExecutionEnvironmentClaim("agent", { execution: {} })).toBeNull();
  });

  it("emits the poison marker for PRESENT-but-malformed declarations (fail-closed at consumption)", () => {
    const POISON = { __invalidExecutionEnvironmentDeclaration: true };
    expect(resolveExecutionEnvironmentClaim("agent", { execution: null })).toEqual(POISON);
    expect(resolveExecutionEnvironmentClaim("agent", { execution: [] })).toEqual(POISON);
    expect(
      resolveExecutionEnvironmentClaim("agent", { execution: { environment: [ENV] } }),
    ).toEqual(POISON);
    expect(
      resolveExecutionEnvironmentClaim("agent", { execution: { environment: "pip" } }),
    ).toEqual(POISON);
  });

  it("CARRIER-KIND GATED: null on every non-agent kind even when a claim is present", () => {
    for (const kind of ["connector", "artifact", "skill", "workflow", undefined]) {
      expect(
        resolveExecutionEnvironmentClaim(kind, { execution: { environment: ENV } }),
      ).toBeNull();
    }
  });

  it("PARITY: the generator resolver and the sdk leaf resolver agree case-for-case", () => {
    const cases = [
      ["agent", { execution: { environment: ENV } }],
      ["agent", { execution: { environment: { bogus: true } } }],
      ["agent", { execution: { environment: [] } }],
      ["agent", { execution: { environment: "pip" } }],
      ["agent", { execution: { environment: null } }],
      ["agent", { execution: {} }],
      ["agent", { execution: null }],
      ["agent", { execution: [] }],
      ["agent", {}],
      ["agent", null],
      ["connector", { execution: { environment: ENV } }],
      ["skill", { execution: { environment: ENV } }],
      [undefined, { execution: { environment: ENV } }],
    ];
    for (const [kind, cin] of cases) {
      expect(resolveExecutionEnvironmentClaim(kind, cin)).toEqual(sdkResolve(kind, cin));
    }
  });
});
