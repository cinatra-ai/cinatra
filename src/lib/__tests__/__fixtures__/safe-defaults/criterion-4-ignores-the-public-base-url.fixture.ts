// NEGATIVE FIXTURE — criterion 4: the fixture-seeding path refuses to run under
// a public exposure signal, and it reads BOTH signals.
//
// This module is never imported by the product. It carries the WRONG version of
// the rule it is named after — a decision that reads only the authentication
// base URL — so the assertion that pins the real rule can be pointed at it and
// REQUIRED to reject it.
//
// An instance whose authentication base URL is a loopback address can still be
// reachable from the whole internet through the public base URL the operator
// configured, which is also what the sign-in stack trusts as an origin. A rule
// that reads one signal and not the other seeds the fixture account on exactly
// that instance, which is the case the criterion exists for.

/** The subset of the shared predicate's inputs a decision has to read. */
export type ExposureInputs = {
  runtimeMode?: string | null;
  nodeEnv?: string | null;
  authBaseUrl?: string | null;
  publicBaseUrl?: string | null;
};

/** What a decision has to answer. */
export type ExposureDecision = { allowed: boolean };

function isLoopbackHost(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

export const CRITERION_4_NEGATIVE_FIXTURE = {
  criterion: 4,
  name: "criterion-4-ignores-the-public-base-url",
  rule: "seeding refuses under EITHER public exposure signal, not only the authentication base URL",
  /** Reads one signal and is blind to the other. */
  decide(inputs: ExposureInputs): ExposureDecision {
    if (inputs.runtimeMode !== "development" || inputs.nodeEnv === "production") return { allowed: false };
    return { allowed: isLoopbackHost(inputs.authBaseUrl) };
  },
} as const;
