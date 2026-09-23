/** Refuse reused/misconfigured servers and unreserved Redis before any tests. */
export async function verifyDesignPartition({ partition, token, redisUrl, request = fetch, readRedisOwner = readOwner }) {
  if (!partition || !token || token.length < 32) throw new Error("partition and seed capability are required");
  const response = await request(`${partition.baseURL}/design-fixtures/conformance/seed`, {
    headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`partition identity probe failed (${response.status})`);
  const actual = (await response.json()).partition;
  for (const key of ["current", "total", "runId", "runBase", "headSha", "database", "port", "baseURL", "redisOrigin", "redisDatabase"]) {
    if (actual?.[key] !== partition[key]) throw new Error(`the server's partition ${key} does not match this run`);
  }
  // The instance is explicitly reserved at provisioning time. Never create
  // this binding here: doing so could claim somebody else's shared Redis.
  if (await readRedisOwner(redisUrl) !== partition.runBase) {
    throw new Error("Redis instance is not reserved for this partition run");
  }
}

async function readOwner(redisUrl) {
  const url = new URL(redisUrl);
  url.pathname = "/0";
  const { default: Redis } = await import("ioredis");
  const client = new Redis(url.href, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 5_000, commandTimeout: 5_000, retryStrategy: () => null });
  // Awaited operations report the error; avoid ioredis' unhandled-event log.
  client.on("error", () => {});
  let timer;
  try {
    return await Promise.race([
      (async () => { await client.connect(); return client.get("cinatra:design-partition:owner"); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Redis ownership probe timed out")), 5_000); }),
    ]);
  } finally { clearTimeout(timer); client.disconnect(); }
}
