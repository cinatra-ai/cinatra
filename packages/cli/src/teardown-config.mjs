// Pure helpers for `cinatra teardown branch`. Extracted from index.mjs so the
// destructive-name resolution and guards can be tested hermetically — no DB,
// no Redis, no git. See packages/cli/tests/teardown-config.test.mjs.
//
// Bug history: `runTeardownBranch` previously derived the
// schema/queue names from the git branch alone, ignoring what the worktree's
// `.env.local` actually declared. When a worktree was set up with a custom
// `--slug` (or had `.env.local` SUPABASE_SCHEMA / BULLMQ_QUEUE_NAME written
// at provisioning time that differed from the branch-derived form), the
// teardown dropped a phantom schema and cleaned a phantom queue while the
// real ones were orphaned. This module makes the
// worktree's own `.env.local` the authoritative source of truth and only
// falls back to slug-derivation when those keys are absent.
//
// MAIN-REPO `.env.local` is deliberately
// NOT consulted for these target names — main's `SUPABASE_SCHEMA=cinatra`
// would point teardown at the live app schema. Worktree-only, else derived.

const SCHEMA_IDENTIFIER_SHAPE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const QUEUE_NAME_SHAPE = /^cinatra-bg-[a-zA-Z0-9_-]+$/;
const PROTECTED_SCHEMAS = new Set([
  "cinatra",
  "public",
  "information_schema",
  "pg_catalog",
]);
const PROTECTED_QUEUES = new Set([
  "cinatra-bg-main",
  "cinatra-bg-cinatra",
]);

/**
 * Resolve the destructive target names for `cinatra teardown branch`.
 *
 * @param {object} args
 * @param {string} args.slug                 Sanitized branch slug (already validated upstream).
 * @param {string|undefined} [args.envSchema] Worktree `.env.local`'s SUPABASE_SCHEMA (trimmed, or undefined).
 * @param {string|undefined} [args.envQueue]  Worktree `.env.local`'s BULLMQ_QUEUE_NAME (trimmed, or undefined).
 * @param {string|undefined} [args.envSource] Path to the worktree `.env.local` (only used in error/summary text).
 * @returns {{schemaName: string, queueName: string, schemaSource: string, queueSource: string}}
 * @throws if either resolved name fails its shape regex or hits a protected name.
 */
export function resolveTeardownNames({
  slug,
  envSchema,
  envQueue,
  envSource,
}) {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("resolveTeardownNames: slug is required");
  }
  const derivedSchema = `cinatra_${slug.replace(/-/g, "_")}`;
  const derivedQueue = `cinatra-bg-${slug}`;
  // Distinguish "key absent" (undefined → fall back to derived) from "key
  // present but blank" (empty string → throw). A blank declaration is a
  // malformed env; silently falling back would mask an operator typo, and
  // for a destructive command that's exactly the failure mode this whole
  // module exists to prevent. Callers must pass the trimmed value or
  // undefined — never a coerced empty default.
  if (envSchema === "") {
    throw new Error(
      `SUPABASE_SCHEMA is declared but blank in ${envSource ?? "worktree .env.local"}. ` +
        `Remove the key to fall back to slug-derived defaults, or set a value.`,
    );
  }
  if (envQueue === "") {
    throw new Error(
      `BULLMQ_QUEUE_NAME is declared but blank in ${envSource ?? "worktree .env.local"}. ` +
        `Remove the key to fall back to slug-derived defaults, or set a value.`,
    );
  }
  const schemaName = envSchema ?? derivedSchema;
  const queueName = envQueue ?? derivedQueue;
  const schemaSource = envSchema !== undefined ? (envSource ?? "worktree .env.local") : "derived from slug";
  const queueSource = envQueue !== undefined ? (envSource ?? "worktree .env.local") : "derived from slug";
  validateSchemaName(schemaName, schemaSource, slug);
  validateQueueName(queueName, queueSource);
  return { schemaName, queueName, schemaSource, queueSource };
}

/**
 * Throws if the schema name is malformed or names a protected app schema.
 * Pure — does no I/O.
 */
export function validateSchemaName(schemaName, source, slug) {
  if (!SCHEMA_IDENTIFIER_SHAPE.test(schemaName)) {
    throw new Error(
      `Refusing to drop schema "${schemaName}" (source: ${source}) — does not match Postgres identifier shape /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.`,
    );
  }
  if (PROTECTED_SCHEMAS.has(schemaName) || slug === "main") {
    throw new Error(
      `Refusing to drop protected schema "${schemaName}" (source: ${source}). This command is only for branch worktrees.`,
    );
  }
}

/**
 * Throws if the queue name is malformed or names a protected queue.
 * Pure — does no I/O.
 */
export function validateQueueName(queueName, source) {
  if (!QUEUE_NAME_SHAPE.test(queueName)) {
    throw new Error(
      `Refusing to clean queue "${queueName}" (source: ${source}) — does not match cinatra-bg-<slug> shape.`,
    );
  }
  if (PROTECTED_QUEUES.has(queueName)) {
    throw new Error(
      `Refusing to clean protected queue "${queueName}" (source: ${source}). This command is only for branch worktrees.`,
    );
  }
}
