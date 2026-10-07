import { designPartition } from "../../../src/lib/test-support/design-partition";
import { verifyDesignPartition } from "../../../scripts/ci/design-partition-preflight.mjs";

export default async function setup() {
  await verifyDesignPartition({
    partition: designPartition(),
    token: process.env.CINATRA_CONFORMANCE_SEED_TOKEN,
    redisUrl: process.env.REDIS_URL,
  });
}
