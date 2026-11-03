import "server-only";

// ---------------------------------------------------------------------------
// THE PAGE CAPTURE'S PER-REVISION FACTS RECORD (cinatra#4223): where, at what
// viewport and when one revision was captured, as the HOST states it.
//
// Not the object data: `objects_save` / `objects_update` merge caller fields
// into it, so three field names there say nothing about who wrote them, and it
// is live, while a settled review must keep its pinned revision's facts. The
// record is one append-only `artifact_audit` row (action `page_capture_facts`),
// a table no objects or MCP write path, route, extension port or trigger writes
// (the trust boundary of artifact-writer-witness.ts). The writer adds it through
// the artifact writer's `additionalTx2Queries`, so it commits with the revision.
//
// The reader answers for ONE (organisation, artifact, revision, type); any
// other record is no record. Two records for one revision, a record that does
// not parse, or a failed read is `unreadable`, never facts; no log line carries
// text of an error.
// ---------------------------------------------------------------------------

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { getPostgresConnectionString, ensurePostgresSchema, postgresSchema } from "@/lib/database";
import { logFailure, logFixedLine } from "@/lib/failure-log";

/** The `artifact_audit.action` of a page capture's facts record. */
export const PAGE_CAPTURE_FACTS_AUDIT_ACTION = "page_capture_facts";

/** The shape version written into the record's detail. */
export const PAGE_CAPTURE_FACTS_RECORD_VERSION = 1;

/** The largest viewport side and URL length a record accepts. */
const MAX_VIEWPORT_SIDE = 65_535;
const MAX_URL_LENGTH = 2_048;

const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** Any control character (tab, line feed and the C1 range included): `new URL` drops some of them silently. */
const CONTROL_CHARACTER = /\p{Cc}/u;
/** User information in the authority, even an empty one (`http://@host`), which `new URL` drops from the parsed URL. */
const URL_USER_INFORMATION = /^[A-Za-z][A-Za-z0-9+.-]*:[/\\]{2}[^/\\?#]*@/;

export type PageCaptureFacts = { capturedUrl: string; viewport: { width: number; height: number }; capturedAt: string };

export type RecordedPageCaptureFacts =
  | { status: "recorded"; facts: PageCaptureFacts }
  | { status: "absent" }
  | { status: "unreadable" };

/** The fixed text of a facts record the writer refuses. It names no input. */
export const PAGE_CAPTURE_FACTS_REFUSED =
  "the page capture facts are not a valid record; nothing was filed";

export class PageCaptureFactsRecordError extends Error {
  constructor() {
    super(PAGE_CAPTURE_FACTS_REFUSED);
    this.name = "PageCaptureFactsRecordError";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

function isSide(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_VIEWPORT_SIDE;
}

function isCapturedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  if (CONTROL_CHARACTER.test(value) || URL_USER_INFORMATION.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // A URL that carries a user name or a password is never recorded or drawn.
  return url.username === "" && url.password === "";
}

/** An ISO date-time with a zone that is a real calendar moment: 2026-02-30 and T24:00 are refused (round trip). */
function isCapturedAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE_TIME.exec(value);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (Number(m[7] ?? 0) > 23 || Number(m[8] ?? 0) > 59) return false;
  const moment = new Date(0);
  moment.setUTCFullYear(year, month - 1, day);
  moment.setUTCHours(hour, minute, second, 0);
  const roundTrips =
    moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 &&
    moment.getUTCDate() === day &&
    moment.getUTCHours() === hour &&
    moment.getUTCMinutes() === minute &&
    moment.getUTCSeconds() === second;
  return roundTrips && Number.isFinite(Date.parse(value));
}

/**
 * The three facts, or `null` when `value` is not exactly a facts object: a plain
 * object with only `capturedUrl` (an absolute http(s) URL without user
 * information or control characters), `viewport` (only integer `width` and
 * `height`, each at least 1) and `capturedAt` (a real ISO date-time with a
 * zone). Total: a value whose reading throws (a getter, a proxy) is `null`.
 */
export function parsePageCaptureFacts(value: unknown): PageCaptureFacts | null {
  try {
    if (!isPlainRecord(value) || !hasExactlyKeys(value, ["capturedUrl", "viewport", "capturedAt"])) return null;
    const { capturedUrl, viewport, capturedAt } = value;
    if (!isCapturedUrl(capturedUrl) || !isCapturedAt(capturedAt)) return null;
    if (!isPlainRecord(viewport) || !hasExactlyKeys(viewport, ["width", "height"])) return null;
    if (!isSide(viewport.width) || !isSide(viewport.height)) return null;
    return { capturedUrl, viewport: { width: viewport.width, height: viewport.height }, capturedAt };
  } catch {
    return null;
  }
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The INSERT of one revision's facts record, as one op for the filing
 * transaction (`additionalTx2Queries` of the artifact writer). `schema` is the
 * unescaped schema name. Throws PageCaptureFactsRecordError, whose text names no
 * input, when an id is empty or the facts do not parse.
 */
export function buildPageCaptureFactsRecordOp(input: {
  schema: string;
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
  objectType: string;
  facts: unknown;
}): { text: string; values: unknown[] } {
  const facts = parsePageCaptureFacts(input.facts);
  if (
    facts === null ||
    !isId(input.orgId) ||
    !isId(input.artifactId) ||
    !isId(input.representationRevisionId) ||
    !isId(input.objectType)
  ) {
    throw new PageCaptureFactsRecordError();
  }
  const schema = input.schema.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${schema}"."artifact_audit"
  (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
VALUES (gen_random_uuid()::text, $1::text, $2::text, $3::text, $4::text, NULL, $5::jsonb)`,
    values: [
      input.orgId,
      input.artifactId,
      input.representationRevisionId,
      PAGE_CAPTURE_FACTS_AUDIT_ACTION,
      JSON.stringify({
        v: PAGE_CAPTURE_FACTS_RECORD_VERSION,
        objectType: input.objectType,
        capturedUrl: facts.capturedUrl,
        viewport: facts.viewport,
        capturedAt: facts.capturedAt,
      }),
    ],
  };
}

export type PageCaptureFactsReadDeps = {
  /** Runs one query and returns its rows; the configured database when omitted. */
  runQuery?: (query: { text: string; values: unknown[] }) => unknown[];
  /** The unescaped schema name; the configured one when omitted. */
  schema?: string;
};

function defaultRunQuery(query: { text: string; values: unknown[] }): unknown[] {
  // The bridge answers every query of a production build with an empty list instead of reading: that is no read,
  // so it is no confirmed absence (the reader answers unreadable for a throw).
  if (process.env.NEXT_PHASE === "phase-production-build") {
    throw new Error("page capture facts are not readable during the production build");
  }
  ensurePostgresSchema();
  const [res] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [query],
  });
  // The rows as the bridge returned them. A missing result or a rows value that is not a list is not an empty
  // list: the reader below answers unreadable for it, never absent.
  return res?.rows as unknown[];
}

/** Read the facts recorded for ONE revision of ONE artifact of ONE type, organisation-scoped. */
export function readPageCaptureFactsForRevision(
  input: { orgId: string; artifactId: string; representationRevisionId: string; objectType: string },
  deps: PageCaptureFactsReadDeps = {},
): RecordedPageCaptureFacts {
  const { orgId, artifactId, representationRevisionId, objectType } = input;
  if (!isId(orgId) || !isId(artifactId) || !isId(representationRevisionId) || !isId(objectType)) {
    return { status: "absent" };
  }
  const schema = (deps.schema ?? postgresSchema).replaceAll('"', '""');
  let rows: unknown[];
  try {
    rows = (deps.runQuery ?? defaultRunQuery)({
      text: `SELECT detail FROM "${schema}"."artifact_audit"
  WHERE org_id = $1 AND artifact_id = $2 AND representation_revision_id = $3 AND action = $4
  ORDER BY created_at ASC, id ASC
  LIMIT 2`,
      values: [orgId, artifactId, representationRevisionId, PAGE_CAPTURE_FACTS_AUDIT_ACTION],
    });
  } catch (err) {
    logFailure("page capture facts: the record read failed", { orgId, artifactId, representationRevisionId }, err);
    return { status: "unreadable" };
  }
  const fields = { orgId, artifactId, representationRevisionId };
  if (!Array.isArray(rows)) {
    logFixedLine("page capture facts: the record read returned no row list", fields);
    return { status: "unreadable" };
  }
  if (rows.length === 0) return { status: "absent" };
  if (rows.length > 1) {
    logFixedLine("page capture facts: a revision has more than one facts record", fields);
    return { status: "unreadable" };
  }
  const first: unknown = rows[0];
  const detail = isPlainRecord(first) ? first.detail : undefined;
  if (
    !isPlainRecord(detail) ||
    detail.v !== PAGE_CAPTURE_FACTS_RECORD_VERSION ||
    !hasExactlyKeys(detail, ["v", "objectType", "capturedUrl", "viewport", "capturedAt"])
  ) {
    logFixedLine("page capture facts: a facts record has an unknown shape", fields);
    return { status: "unreadable" };
  }
  if (detail.objectType !== objectType) return { status: "absent" };
  const { capturedUrl, viewport, capturedAt } = detail;
  const facts = parsePageCaptureFacts({ capturedUrl, viewport, capturedAt });
  if (facts === null) {
    logFixedLine("page capture facts: a facts record does not parse", fields);
    return { status: "unreadable" };
  }
  return { status: "recorded", facts };
}
