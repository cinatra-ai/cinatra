// ---------------------------------------------------------------------------
// Thread TITLE-SLUG allocator — the PURE core (cinatra#1878 W3, AC#2).
// ---------------------------------------------------------------------------
// A thread's URL segment is a NET-NEW title-slug (today's URLs carry a thread
// UUID). The slug is minted ONCE from a thread's title, container-scoped-unique
// over `(assistantPackage, instance?)`, and STABLE forever (a rename never
// re-slugs). This module owns the pure, DB-free half: title → normalized base
// slug, a short collision suffix, and the candidate stream the DB seam
// (assistant-thread-store) tries against the container's UNIQUE index. Keeping
// the normalization + collision policy here makes the allocator's behaviour
// unit-testable without a database (the atomicity itself is proven at the store
// seam by the unique index + first-writer-wins conditional write).

/** The longest a title-slug may be (URL-friendly cap). */
export const THREAD_SLUG_MAX_LEN = 64;

/** The slug for a title that normalizes to nothing (emoji-only, CJK-only under
 *  the ASCII normalizer, whitespace, …). */
export const FALLBACK_THREAD_SLUG = "thread";

/** Raised when the collision loop cannot find a free slug within its budget AND
 *  no guaranteed-unique tail was supplied (should never happen in practice —
 *  the store seam always has the thread id as a last-resort tail). */
export class ThreadSlugExhaustedError extends Error {
  constructor(base: string) {
    super(`[thread-slug] exhausted collision candidates for base "${base}"`);
    this.name = "ThreadSlugExhaustedError";
  }
}

/**
 * Normalize a thread title into a base slug: NFKD-fold, lowercase, collapse
 * every non-`[a-z0-9]` run to a single hyphen, trim leading/trailing hyphens,
 * cap length. An empty result falls back to {@link FALLBACK_THREAD_SLUG}. Pure +
 * total.
 */
export function slugifyTitle(title: string | null | undefined): string {
  const base = (title ?? "")
    .normalize("NFKD")
    // Drop the combining diacritical marks NFKD split off (café → cafe), so an
    // accented letter folds to its base letter rather than becoming a separator.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, THREAD_SLUG_MAX_LEN)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : FALLBACK_THREAD_SLUG;
}

/** A short (4-char base36) collision suffix. Deterministic given `rng`. */
export function shortSlugSuffix(rng: () => number = Math.random): string {
  return Math.floor(rng() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
    .slice(0, 4);
}

/** Append a suffix, trimming the base so the total stays within the length cap
 *  and never ends on a stray hyphen. */
export function withSlugSuffix(base: string, suffix: string): string {
  const room = THREAD_SLUG_MAX_LEN - (suffix.length + 1);
  const trimmed = base.slice(0, Math.max(1, room)).replace(/-+$/g, "");
  return `${trimmed.length > 0 ? trimmed : FALLBACK_THREAD_SLUG}-${suffix}`;
}

/**
 * Append a GUARANTEED-unique tail (e.g. a slice of the thread UUID) — the store
 * seam's last resort when the random collision loop is exhausted, so a slug is
 * ALWAYS mintable (AC#2 "no titled row commits slugless"). Deterministic.
 */
export function slugWithUniqueTail(base: string, uniqueTail: string): string {
  const tail = uniqueTail.replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 12) || "id";
  return withSlugSuffix(base, tail);
}

/**
 * The candidate stream for a base slug: first the bare base, then `base-<suffix>`
 * with fresh short suffixes forever (de-duped against earlier yields so a
 * repeated rng draw is skipped). The store seam consumes this lazily, attempting
 * each candidate against the container unique index until one commits.
 */
export function* slugCandidates(
  base: string,
  rng: () => number = Math.random,
): Generator<string, never, unknown> {
  yield base;
  const seen = new Set<string>([base]);
  for (;;) {
    let cand = withSlugSuffix(base, shortSlugSuffix(rng));
    let guard = 0;
    while (seen.has(cand) && guard++ < 16) {
      cand = withSlugSuffix(base, shortSlugSuffix(rng));
    }
    seen.add(cand);
    yield cand;
  }
}

/**
 * The allocation LOOP, driven by an injected `attempt`. `attempt(candidate)`
 * returns `true` when the candidate was COMMITTED (the caller writes it under the
 * container's UNIQUE index in the same call) and `false` on a container collision
 * (retry the next candidate). Returns the committed slug. After `maxTries`
 * random suffixes it tries `uniqueTail` (guaranteed free) when supplied, else
 * throws {@link ThreadSlugExhaustedError}.
 *
 * This is the SEAM the store uses: each `attempt` is a real conditional
 * INSERT/UPDATE against `assistant_threads` guarded by the container unique
 * index, so the whole loop is atomic per attempt and first-writer-wins. It is
 * also exhaustively unit-testable with an in-memory container map (no DB).
 */
export function allocateByAttempt(
  base: string,
  attempt: (candidate: string) => boolean,
  opts: { rng?: () => number; maxTries?: number; uniqueTail?: string } = {},
): string {
  const { rng = Math.random, maxTries = 50, uniqueTail } = opts;
  let tries = 0;
  for (const cand of slugCandidates(base, rng)) {
    if (attempt(cand)) return cand;
    if (tries++ >= maxTries) break;
  }
  if (uniqueTail != null) {
    const tailed = slugWithUniqueTail(base, uniqueTail);
    if (attempt(tailed)) return tailed;
  }
  throw new ThreadSlugExhaustedError(base);
}

/**
 * Pure allocation against an in-memory taken-predicate — the testable twin of
 * the store seam's index-driven retry. Returns the first candidate `isTaken`
 * rejects; after `maxTries` random suffixes it falls back to `uniqueTail`
 * (guaranteed free) when supplied, else throws {@link ThreadSlugExhaustedError}.
 */
export function allocateSlug(
  base: string,
  isTaken: (slug: string) => boolean,
  opts: { rng?: () => number; maxTries?: number; uniqueTail?: string } = {},
): string {
  return allocateByAttempt(base, (cand) => !isTaken(cand), opts);
}
