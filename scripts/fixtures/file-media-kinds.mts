// Development operator fixture: file one artifact of each of the six media
// kinds the review island's byte road serves, and optionally open a real review
// gate that pins all six.
// Run with: node --env-file=.env.local scripts/fixtures/file-media-kinds.mjs
//   --org ... --user ... [--review-run]
import { parseArgs } from "node:util";
import {
  assertMediaFixtureRuntime, fileMediaKindSamples, normalizeFixtureIds, seedMediaKindReviewRun,
} from "./lib/file-media-kinds.ts";

assertMediaFixtureRuntime();
const { values } = parseArgs({ options: {
  org: { type: "string" }, user: { type: "string" }, "review-run": { type: "boolean" },
} });
if (values.org === undefined || values.user === undefined) throw new Error("--org and --user are required");
const ids = normalizeFixtureIds({ orgId: values.org, userId: values.user });
if (values["review-run"] && (!process.env.SUPABASE_DB_URL || !process.env.REDIS_URL || !process.env.BULLMQ_QUEUE_NAME)) {
  throw new Error("--review-run needs an isolated database, Redis and an explicit queue name");
}
const filed = await fileMediaKindSamples(ids);
const reviewTargets = filed.map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId }));
console.log(JSON.stringify({ filed, review_targets: reviewTargets }));
if (values["review-run"]) {
  // The shipped marked-gate path, as the e2e harness drives it: only run
  // creation is seeded; WayFlow pauses the run and the executor pins the six.
  console.log(JSON.stringify(await seedMediaKindReviewRun({ ...ids, filed })));
}
