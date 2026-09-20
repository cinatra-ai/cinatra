/** Opt-in two-partition contract shared by the server and Playwright process. */
export function designPartition(env: Record<string, string | undefined> = process.env) {
  if (!env.CINATRA_DESIGN_PARTITION) return undefined;
  if (!/^[12]\/2$/.test(env.CINATRA_DESIGN_PARTITION)) {
    throw new Error("CINATRA_DESIGN_PARTITION must be 1/2 or 2/2");
  }
  const current = Number(env.CINATRA_DESIGN_PARTITION[0]);
  const base = env.CINATRA_DESIGN_PARTITION_RUN_ID;
  if (!base || !/^[a-z0-9][a-z0-9-]{0,33}$/.test(base)) {
    throw new Error("an explicit partition run id (1–34 lowercase letters/digits/hyphens) is required");
  }
  const headSha = env.CINATRA_DESIGN_HEAD_SHA;
  if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error("an explicit 40-character partition head SHA is required");
  const runId = `${base}-p${current}`;
  const database = `cinatra_design_${base.replaceAll("-", "_")}_p${current}`;
  let db: URL;
  let redis: URL;
  try {
    db = new URL(env.SUPABASE_DB_URL ?? "");
    redis = new URL(env.REDIS_URL ?? "");
  } catch { throw new Error("partition database and Redis URLs are required"); }
  // A separate schema is insufficient: setup also writes public auth tables.
  if (!/^postgres(?:ql)?:$/.test(db.protocol) || decodeURIComponent(db.pathname.slice(1)) !== database) {
    throw new Error(`partition ${current} requires its own database named ${database}`);
  }
  if (!/^rediss?:$/.test(redis.protocol) || redis.pathname !== `/${current}`) {
    throw new Error(`partition ${current} requires Redis database ${current}`);
  }
  const basePort = Number(env.CINATRA_DESIGN_PARTITION_BASE_PORT);
  if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65534) {
    throw new Error("an explicit partition base port between 1024 and 65534 is required");
  }
  const port = basePort + current - 1;
  if (env.PORT && Number(env.PORT) !== port) throw new Error(`partition ${current} server PORT must be ${port}`);
  if (env.E2E_DESIGN_PORT && Number(env.E2E_DESIGN_PORT) !== port) throw new Error(`partition ${current} test port must be ${port}`);
  const baseURL = `http://127.0.0.1:${port}`;
  if (env.E2E_DESIGN_BASE_URL && new URL(env.E2E_DESIGN_BASE_URL).origin !== baseURL) {
    throw new Error(`partition ${current} must target its own server at ${baseURL}`);
  }
  if (env.CINATRA_CONFORMANCE_RUN_ID && env.CINATRA_CONFORMANCE_RUN_ID !== runId) {
    throw new Error("partition run namespace differs between the server and tests");
  }
  return { current, total: 2, runId, runBase: base, headSha, database, port, baseURL, redisOrigin: `${redis.protocol}//${redis.host}`, redisDatabase: current };
}
