// -----------------------------------------------------------------------------
// Test-only marketplace MCP stub for a graded dev-road walk of the marketplace
// approval tables (cinatra#4296). Like ../marketplace-install/fixture-server.mjs,
// it is a tiny, dependency-free HTTP server with no real bearer and no external
// network. It keeps the shipped pages: only the marketplace behind them is a
// stand-in, and every row is one the drawing (specs/app.html V.2) draws.
//
// It answers the MCP calls of the marketplace client on POST /wp-json/cinatra/mcp:
//   initialize, notifications/initialized and tools/call of the four tools below.
// Any other tool is a JSON-RPC error, so a page that needs more fails visibly.
//
// Wire it via env on the app under test:
//   MARKETPLACE_BASE_URL   = http://localhost:<port>
//   MARKETPLACE_ADMIN_TOKEN = <any non-empty>
// (MARKETPLACE_BASE_URL is honored only outside NODE_ENV=production, i.e. the
// `pnpm dev` server, never a production instance.)
// -----------------------------------------------------------------------------

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const HOST = "localhost";
const MCP_PATH = "/wp-json/cinatra/mcp";

const application = (id, scope, displayName, status, extra = {}) => ({
  application_id: id,
  scope,
  vendor_id: 1,
  status,
  tier: "free",
  terms_version: "1",
  terms_digest: "stub",
  display_name: displayName,
  applicant_user_id: 1,
  applied_at: "2026-10-01T09:00:00Z",
  decided_at: null,
  decided_by_admin_id: null,
  decision_reason: null,
  reserved_at: "2026-10-01T09:00:00Z",
  recovery_attempts: 0,
  repair_stuck_at: null,
  ...extra,
});
export const VENDOR_APPLICATIONS = [
  application("stub-app-1", "acme", "Acme Tools", "approved", { recovery_attempts: 3, repair_stuck_at: "2026-10-02T09:00:00Z" }),
  application("stub-app-2", "northwind", "Northwind Labs", "applied"),
];

const submission = (id, name, status, promotionState) => ({
  submission_id: id,
  namespace: "acme",
  extension_name: name,
  version: "1.0.0",
  status,
  target_final_identity: `@acme/${name}`,
  artifact_digest: "stub",
  submitted_at: "2026-10-01T09:00:00Z",
  decided_at: "2026-10-02T09:00:00Z",
  decision_reason: null,
  promotion_state: promotionState,
  promotion_error: null,
  final_artifact_digest: null,
});
export const SUBMISSIONS = [
  submission("stub-sub-1", "support-desk", "approved", "in_flight"),
  submission("stub-sub-2", "crm-sync", "approved", "failed"),
  submission("stub-sub-3", "mail-digest", "promoted", "complete"),
];

// The fields of each reply row, as the shipped marketplace client's types declare them:
// MarketplaceVendorSubmission, MarketplaceAdminSubmission and
// MarketplaceVendorApplicationAdminRow. Each list reply cuts its rows to its own list, so a row that a test
// passes in carries no other field into a reply: the vendor's own list drops the admin-only fields and
// `eligibility`, and every list drops a field that no type has. marketplace-mcp-stub.test.ts compares
// these lists with key maps that the compiler checks against those types.
export const VENDOR_SUBMISSION_FIELDS = [
  "submission_id", "namespace", "extension_name", "version", "status", "target_final_identity", "artifact_digest",
  "submitted_at", "decided_at", "decision_reason", "promotion_state", "promotion_error", "final_artifact_digest",
];
export const ADMIN_SUBMISSION_FIELDS = [
  ...VENDOR_SUBMISSION_FIELDS,
  "vendor_id", "staging_artifact_path", "artifact_size_bytes", "submitter_id", "decided_by_admin_id", "description",
  "deps_json", "eligibility",
];
export const APPLICATION_ROW_FIELDS = [
  "application_id", "scope", "vendor_id", "status", "tier", "terms_version", "terms_digest", "display_name",
  "applicant_user_id", "applied_at", "decided_at", "decided_by_admin_id", "decision_reason", "reserved_at",
  "recovery_attempts", "repair_stuck_at", "eligibility",
];
const only = (fields) => (row) => Object.fromEntries(fields.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]));
const ADMIN_DEFAULTS = { vendor_id: 1, staging_artifact_path: "stub", artifact_size_bytes: 1, submitter_id: 1, decided_by_admin_id: 1, description: null, deps_json: null };

// The tool table for one set of rows. A walk uses the default rows; a test passes its own.
export function toolsFor({ applications = VENDOR_APPLICATIONS, submissions = SUBMISSIONS } = {}) {
  return {
    "cinatra-vendor-application-list-admin": ({ status } = {}) => {
      const wanted = Array.isArray(status) ? status : [];
      const rows = (wanted.length
        ? applications.filter((row) => wanted.includes(row.status) || (wanted.includes("stuck") && row.repair_stuck_at))
        : applications).map(only(APPLICATION_ROW_FIELDS));
      return { rows, next_cursor: null };
    },
    "cinatra-extension-submission-list-admin": ({ status } = {}) => {
      const rows = status ? submissions.filter((row) => row.status === status) : submissions;
      return { submissions: rows.map((row) => only(ADMIN_SUBMISSION_FIELDS)({ ...ADMIN_DEFAULTS, ...row })) };
    },
    "cinatra-extension-submission-list-self": () => ({ submissions: submissions.map(only(VENDOR_SUBMISSION_FIELDS)) }),
    "cinatra-vendor-application-status": () => ({ state: "approved", scope: "acme", application_id: "stub-app-1", tier: "free", repair_stuck_at: "2026-10-02T09:00:00Z" }),
  };
}
export const TOOLS = toolsFor();

function answer(message, tools) {
  const reply = (body) => ({ jsonrpc: "2.0", id: message.id, ...body });
  if (message.method === "initialize") {
    return reply({ result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "marketplace-mcp-stub", version: "1.0.0" } } });
  }
  if (message.method === "tools/call" && Object.hasOwn(tools, message.params?.name)) {
    const output = tools[message.params.name](message.params.arguments ?? {});
    return reply({ result: { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output } });
  }
  return reply({ error: { code: -32601, message: `the stub does not answer ${message.method} ${message.params?.name ?? ""}`.trim() } });
}

export function createStub(data) {
  const tools = toolsFor(data);
  return createServer((req, res) => {
    const path = new URL(req.url, `http://${HOST}`).pathname;
    if (path !== MCP_PATH || req.method !== "POST") {
      res.writeHead(path === MCP_PATH ? 405 : 404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (message.id === undefined) {   // a notification takes no answer
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer(message, tools)));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.E2E_MP_FIXTURE_PORT ?? 4598);
  createStub().listen(port, HOST, () => console.log(`marketplace MCP stub on ${HOST}:${port}`));
}
