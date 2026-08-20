// S9c round-2 capture, step 3 — put a REAL pending review gate in front of the
// capture actor.
//
// The run row is seeded by the sanctioned e2e harness bypass
// (`seedMarkedReviewGateRun`, tests/e2e/agents-run/review-gate-fixture.ts). The
// lifecycle rows are NOT written here: they are written by the SHIPPED writers
// behind `POST /api/development/lifecycle-seed`, which contains no SQL of its
// own and refuses to seed a card the named actor could not open.
//
// Usage: node --conditions=react-server --env-file=.env.local --import tsx 04-seed-review-gate.mts <baseUrl>
import { randomUUID } from "node:crypto";

import { seedMarkedReviewGateRun } from "../../../tests/e2e/agents-run/review-gate-fixture";

const BASE = process.argv[2] || "http://localhost:3072";
const orgId = process.env.S9C_ORG_ID;
const actorId = process.env.S9C_ADMIN_USER_ID;
const token = process.env.CINATRA_LIFECYCLE_SEED_TOKEN;
if (!orgId || !actorId) throw new Error("set S9C_ORG_ID and S9C_ADMIN_USER_ID");
if (!token) throw new Error("CINATRA_LIFECYCLE_SEED_TOKEN is not in the environment");

const seeded = await seedMarkedReviewGateRun({
  userId: actorId,
  orgId,
  // The run is ONLY the authorization anchor the seed route insists on: it must
  // be a run this actor may read and decide on. Its input targets are never
  // executed (no runtime consumes this row in the capture), and the artifacts the
  // card actually draws are minted by the shipped writers inside the seed route.
  targets: [{ artifactId: randomUUID(), representationRevisionId: randomUUID() }],
});
const runId = typeof seeded === "string" ? seeded : (seeded as { runId: string }).runId;
console.log(`RUN ${runId}`);

const res = await fetch(`${BASE}/api/development/lifecycle-seed`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ fixture: "repairVerification", orgId, actorId, runId }),
});
const text = await res.text();
console.log(`SEED status ${res.status}`);
console.log(text);
if (!res.ok) throw new Error("lifecycle-seed refused");
