/**
 * Pure Zod input schemas for all agents MCP tools.
 * No server imports — safe to import in unit tests.
 */
import { z } from "zod";
import { AGENT_RUN_TIMEOUT_MAX_SECONDS } from "../wayflow-url";

export type ToolMeta = { description: string; inputSchema: z.ZodTypeAny };

export const AGENT_BUILDER_TOOL_META: Record<string, ToolMeta> = {
  "agent_compile": {
    description: "Compile a natural language workflow description into a structured agent definition using available MCP tools.",
    inputSchema: z.object({
      sourceNl: z.string().describe("Natural language description of the workflow to compile."),
      executionProvider: z.enum(["wayflow"]).optional().describe("Execution backend. Only 'wayflow' is accepted because LangGraph is retired. Defaults to 'wayflow'."),
    }),
  },
  "agent_save": {
    description: "Save a compiled agent definition as a reusable template with a version snapshot.",
    inputSchema: z.object({
      name: z.string().describe("Human-readable name for the agent template."),
      description: z.string().optional().describe("Optional description of what this agent does."),
      sourceNl: z.string().describe("Original natural language description."),
      compiledPlan: z.string().optional().describe("JSON string of the compiled CompiledStep[] array. Omit or pass '[]' when not applicable."),
      inputSchema: z.string().describe("JSON string of the JSON Schema for workflow inputs."),
      outputSchema: z.string().optional().describe("JSON string of the JSON Schema for workflow outputs."),
      approvalPolicy: z.string().optional().describe("JSON string of the approval policy for steps."),
      taskSpec: z.string().optional().describe("Free-form task specification string returned by agent_compile."),
      type: z.enum(["leaf", "proxy", "orchestrator", "parallel", "supervisor", "iterative", "flow", "node"]).optional().describe("Agent type classification. 'leaf' = executes steps directly (default); 'proxy' = installed external agent package; 'orchestrator' = multi-agent coordinator composed of sub-agents. 'parallel' = fan-out/map-reduce; 'supervisor' = LLM supervisor loop; 'iterative' = refinement loop. 'flow' = WayFlow multi-step orchestrator (OAS 26.1.0+). 'node' = WayFlow single-step node. Defaults to 'leaf'."),
    }),
  },
  "agent_run": {
    description: "Run an installed Cinatra agent. **Use this as the FIRST ACTION when the user explicitly asks to use, run, invoke, call, or dispatch an agent, or when the user names an agent package (the canonical scoped form looks like '@cinatra-ai/<slug>-agent').** Prefer `packageName`; do NOT call `agent_list` first when the packageName is already present in the prompt. Use `templateId` only when a prior tool result returned a UUID. Exactly one of `packageName` or `templateId` is required; passing both returns `Pass exactly one of templateId or packageName to agent_run.`. When passing `packageName` with a vendor scope that EXACTLY matches this instance's operator-vendor namespace (e.g. `@<your-instance-namespace>/<slug>`), the resolver auto-aliases to the canonical `@cinatra-ai/<slug>` so in-repo agents are reachable regardless of which scope a chat assistant scraped from Verdaccio. Arbitrary third-party scopes are NOT collapsed — `@somevendor/foo` returns `Template not found`. In the source-authoring pipeline this is also the final step: after `agent_source_write` → `agent_source_validate` → `agent_source_compile` → `agent_source_publish`, call `agent_run` to execute the published agent. Returns `{ runId, status: 'queued' }` on success — the run is async (BullMQ); MUST be followed by `agent_run_get` polling until a terminal status (`completed | failed | pending_approval | stopped`). Returns a structured rejection like `{ code: 'WAYFLOW_AGENT_NOT_REGISTERED' | 'WAYFLOW_NOT_CONFIGURED', error, ... }` when a preflight check rejects dispatch — surface the `error` verbatim and DO NOT poll.",
    inputSchema: z.object({
      templateId: z.string().optional().describe("UUID of the agent template to run. Use only when a prior tool result returned it. Otherwise prefer `packageName`."),
      packageName: z.string().optional().describe("Package name of the agent to run (canonical scoped form '@cinatra-ai/<slug>-agent'). Resolved against `agent_templates.package_name` with current-vendor → `@cinatra-ai/<slug>` alias fallback. Mutually exclusive with `templateId`."),
      inputParams: z.string().optional().describe("JSON string of input parameters for the workflow run."),
      timeoutSeconds: z.number().int().min(1).max(AGENT_RUN_TIMEOUT_MAX_SECONDS).optional().describe(`Optional server-side timeout in seconds. The run self-terminates with a 'timed_out' error state if execution exceeds this limit. Max ${AGENT_RUN_TIMEOUT_MAX_SECONDS}s (24h) — aligned with the WayFlow ApiNode + A2A batch-LLM SLA. Omit for no timeout (default behavior).`),
    }),
  },
  "agent_list": {
    description: "List saved agent templates. Supports search, status/mode filtering, and pagination. Returns items[], total, and hasMore.",
    inputSchema: z.object({
      query: z.string().optional().describe("Case-insensitive name search."),
      status: z.enum(["draft", "published", "archived"]).optional().describe("Filter by template status."),
      packageName: z.string().optional().describe("Exact package name filter (canonical scoped form '@cinatra-ai/<slug>-agent'). When provided, only templates with this exact packageName are returned."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results per page (default 50, max 200)."),
      offset: z.number().int().min(0).optional().describe("Number of results to skip for pagination (default 0)."),
    }),
  },
  "agent_get": {
    description: "Retrieve a saved agent template by ID. Returns the full template including compiledPlan, taskSpec, inputSchema, and sourceNl.",
    inputSchema: z.object({
      templateId: z.string().describe("ID of the agent template to retrieve."),
    }),
  },
  "agent_run_get": {
    description: "Get the status and results of an agent run by ID. Returns status, stepResults, error, startedAt, and completedAt. Poll this after agent_run until status is one of the terminal values: 'completed', 'failed', 'pending_approval', or 'stopped'.",
    inputSchema: z.object({
      runId: z.string().describe("ID of the agent run to retrieve."),
    }),
  },
  "agent_run_list": {
    description: "List agent builder runs. When templateId is omitted, returns runs across all templates for the org. Supports status filter and cursor-based pagination. Returns metadata only (id, templateId, status, inputParams, startedAt, completedAt). If nextCursor is present, call again with cursor=<nextCursor> to retrieve the next page. NOTE: `total` reflects the post-policy-filter visible count for this page, not the global DB count — paginate via nextCursor (or until items.length < limit) rather than relying on `total` for an overall row count.",
    inputSchema: z.object({
      templateId: z.string().optional().describe("ID of a specific agent template to filter by. Omit to return runs across all templates."),
      templateIds: z.array(z.string()).optional().describe("List of template IDs to filter by (multi-select). Takes precedence over templateId when both are provided."),
      status: z.enum(["queued", "running", "completed", "failed", "stopped", "pending_approval"]).optional().describe("Filter by run status."),
      limit: z.number().int().min(1).max(200).optional().describe("Max results per page (default 50, max 200)."),
      cursor: z.string().optional().describe("Opaque cursor token from a previous response's nextCursor field. Omit or pass undefined to start from the first page."),
      // Sealed-room read filter. When
      // set, results are restricted to runs with `agent_runs.project_id
      // = $projectId`. The handler 404-hides
      // if the actor has no read+ grant on the project. Subject to
      // CINATRA_SEALED_ROOM_AGENT_RUNS feature flag.
      projectId: z.string().nullish().describe("Sealed-room filter: restrict results to a single project (the actor must have a read+ grant)."),
    }),
  },
  // `agent_run_update` is limited to the project-move surface. The other run fields
  // (status, errors, etc.) are not user-mutable — they are owned by the
  // `transitionRunStatus` state machine. This primitive's ONLY mutable
  // field today is `projectId`. Additional mutable fields require their
  // own design and guards.
  "agent_run_update": {
    description:
      "Update an agent run's mutable fields. The only currently-mutable field is `projectId` — move the run between projects (and into/out of ambient). Use `agent_run_move_with_outputs` to move the run AND its provenance-linked output objects in one transaction. Active runs (status not in {queued, completed, failed, stopped}) are rejected — finish or cancel the run before moving it.",
    inputSchema: z.object({
      runId: z.string().describe("ID of the agent run to update."),
      projectId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Target project_id to move the run into. Pass null to move OUT of a project (back to ambient). The actor must hold write/admin on the SOURCE project and write on the TARGET project (assertProjectWritable). Active-run status guards apply.",
        ),
      reason: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("Optional annotation recorded on the resource_project_moves audit row."),
    }),
  },
  // `agent_run_move_with_outputs` moves
  // the run AND every provenance-linked output object (`objects.run_id =
  // runId`) in one transactional cascade. Cross-tenant moves are rejected
  // (the kernel cross-org guard fires on the project rows).
  "agent_run_move_with_outputs": {
    description:
      "Move an agent run AND every output object it created (objects.run_id = runId) to a new project in one transaction. Cross-tenant moves are rejected. Active-run status guards apply (status must be in {queued, completed, failed, stopped}). Audit rows in `resource_project_moves` are emitted for the run AND each moved object.",
    inputSchema: z.object({
      runId: z.string().describe("ID of the agent run to move."),
      newProjectId: z
        .string()
        .nullable()
        .describe(
          "Target project_id. Pass null to move OUT of any project (back to ambient).",
        ),
      reason: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("Optional annotation recorded on every resource_project_moves audit row."),
    }),
  },
  "agent_run_resume": {
    description: "Resume a pending_approval agent run. Enqueues the resume job immediately. Use agent_run_get to poll until status changes from 'pending_approval'.",
    inputSchema: z.object({
      runId: z.string().describe("ID of the pending_approval run to resume."),
      userResponse: z.string().optional().describe("Optional structured-form response to send to WayFlow as the resume message — typically JSON.stringify of the renderer's payload. Wins over approvalNote when both are present. Passed through unchanged to preserve formatting. REQUIRED for a setup-input gate (a run paused before execution because required inputs were missing): pass JSON.stringify of an object of the missing input fields, e.g. JSON.stringify({ seedUrls: [\"https://...\"] }) — it is merged into the run's inputParams."),
      approvalNote: z.string().optional().describe("Optional free-text note used as the resume message when userResponse is absent. Trimmed before sending. Falls back to '[Approved by operator]' when both userResponse and approvalNote are missing or empty."),
    }),
  },
  "agent_run_messages_list": {
    description: "List the message thread for an agent run. Returns all messages with role, messageType, body, and sequence. Use messageType='final' to fetch only the final assistant response (useful for verifying sentinel stripping).",
    inputSchema: z.object({
      runId: z.string().describe("ID of the agent run whose messages to retrieve."),
      messageType: z.enum(["setup", "user", "assistant", "tool", "final"]).optional().describe("Filter to a specific message type. Omit to return all messages."),
    }),
  },
  "agent_run_stop": {
    description: "Stop a running agent run by ID. Marks the run as stopped in the database; the background job halts after its current step completes.",
    inputSchema: z.object({
      runId: z.string().describe("ID of the agent run to stop."),
    }),
  },
  "agent_runs_stop": {
    description: "Bulk-stop agent runs. Accepts either a templateId (stops all active runs for that template) or an explicit list of runIds. Returns a summary of stopped vs. already-terminal counts.",
    inputSchema: z.object({
      templateId: z.string().optional().describe("Stop all queued/running/pending runs for this template."),
      runIds: z.array(z.string()).optional().describe("Explicit list of run IDs to stop. Takes precedence over templateId when both are provided."),
    }).refine((v) => v.templateId !== undefined || (v.runIds !== undefined && v.runIds.length > 0), {
      message: "Provide either templateId or a non-empty runIds array.",
    }),
  },
  "agent_delete": {
    description: "Permanently delete a saved agent template by ID.",
    inputSchema: z.object({
      templateId: z.string().describe("ID of the agent template to delete."),
    }),
  },
  "agent_template_duplicate": {
    description: "Duplicate an existing agent template. Creates a new draft copy with the same taskSpec, compiledPlan, and schemas. Optionally provide a new name; defaults to 'Copy of <original name>'.",
    inputSchema: z.object({
      templateId: z.string().describe("ID of the template to duplicate."),
      name: z.string().optional().describe("Name for the new copy. Defaults to 'Copy of <original name>'."),
    }),
  },
  "agent_update": {
    description: "Update fields of a saved agent template in place (name, description, taskSpec, sourceNl, status, inputSchema, approvalPolicy, type, executionProvider, agentDependencies). executionProvider only accepts 'wayflow'.",
    inputSchema: z.object({
      templateId: z.string().describe("ID of the agent template to update."),
      name: z.string().optional().describe("New human-readable name."),
      description: z.string().optional().describe("New description."),
      taskSpec: z.string().optional().describe("Replacement agentic task spec string."),
      sourceNl: z.string().optional().describe("Replacement natural-language source description."),
      status: z.enum(["draft", "published", "archived"]).optional().describe("New status. Use 'published' to promote a draft template to active use, 'archived' to retire it."),
      inputSchema: z.record(z.string(), z.unknown()).optional().describe("Replacement JSON Schema object for agent inputs (including x-setup-steps). Replaces the entire inputSchema field."),
      type: z.enum(["leaf", "proxy", "orchestrator", "parallel", "supervisor", "iterative", "flow", "node"]).optional().describe("Agent type classification. Use to promote/demote an existing template between 'leaf' (direct execution), 'proxy' (installed external agent), and 'orchestrator' (multi-agent coordinator). 'parallel' = fan-out/map-reduce; 'supervisor' = LLM supervisor loop; 'iterative' = refinement loop. 'flow' = WayFlow multi-step orchestrator (OAS 26.1.0+). 'node' = WayFlow single-step node (OAS 26.1.0+)."),
      executionProvider: z.enum(["wayflow"]).optional().describe("Execution backend. Only 'wayflow' is accepted because LangGraph is retired. Existing DB rows with 'langgraph' or 'default' values remain readable but cannot be written via this tool."),
      packageName: z.string().optional().describe("Set the stable package identity for a proxy_v1 agent (e.g. '@cinatra/my-agent'). Can only be set once — rejected with an error if packageName is already set on the template."),
      /**
       * @deprecated DECLARE/WRITE surface for the legacy `cinatra.agentDependencies`
       * vocabulary. The canonical replacement is `cinatra.dependencies`. Kept
       * during the deprecation window for back-compat. (Removal tracked as a
       * follow-up milestone.)
       */
      agentDependencies: z.record(z.string(), z.string()).optional().describe("[DEPRECATED — use the canonical cinatra.dependencies vocabulary] Child agent dependencies for orchestrator templates. Maps packageName to semver range (e.g. { '@cinatra/stage-1': '^1.0.0' }). Pass {} to clear all dependencies."),
      approvalPolicy: z.record(z.string(), z.unknown()).optional().describe("Replacement approval policy object (e.g. { steps: [...] }). Replaces the entire approvalPolicy field. Use to update HITL step definitions, renderers, gateCount, and hitlOwnedBy without republishing the agent package."),
    }),
  },
  "agent_export": {
    description: "Export an agent template's canonical on-disk OAS source package as a portable ZIP archive (base64-encoded). The ZIP contains agent.json (the OAS Flow 26.1.0 agent definition), manifest.json with format metadata, and — when present on disk — the package's real sidecar files: package.json (package identity + SPDX license) and LICENSE/LICENSE.md/COPYING/.spdx (required by agent_import's license gate). Use agent_import to restore the agent on any Cinatra instance. Fails with an explicit error (no ZIP) when the template has no canonical on-disk OAS source (e.g. a DB-only template without a packageName): the DB row is a derived cache and cannot be inverted into an importable definition — materialize the source package first via agent_source_write + agent_source_compile.",
    inputSchema: z.object({
      templateId: z.string().describe("ID of the agent template to export."),
    }),
  },
  "agent_import": {
    description: "Import an agent template from a ZIP archive created by agent_export. When the archive carries a package.json whose name matches an existing template's packageName, that template is updated in place (upsert); otherwise a new template is created with a fresh ID (the original OAS Flow id is preserved inside agent.json for provenance). Newly created templates start in 'draft' status.",
    inputSchema: z.object({
      zipBase64: z.string().describe("Base64-encoded ZIP archive produced by agent_export."),
      name: z.string().optional().describe("Override the agent name on import. If omitted, the original name from the archive is used."),
    }),
  },
  "agent_registry_publish": {
    description: "Publish an agent template to Verdaccio as an installable Cinatra agent package. Requires a user-supplied semver and returns packageName, packageVersion, registryUrl, published/alreadyPublished flags, plus detailPath — the canonical workspace URL (e.g. `/agents/<vendor>/<slug>/new`) callers should use verbatim when linking the published agent. Never compose the URL from packageName yourself.",
    inputSchema: z.object({
      templateId: z.string().describe("ID of the agent template to publish."),
      semver: z.string().describe("Semantic version string used as the Verdaccio package version (for example '1.0.0')."),
      changelog: z.string().optional().describe("What changed in this release. Defaults to 'Initial release'."),
    }),
  },
  "agent_registry_list": {
    description: "List non-deprecated Cinatra agent packages published to Verdaccio. Returns items[], total, hasMore. Each item includes packageName, packageVersion, title, description, changelog, riskLevel, hasApprovalGates, toolAccess, publishedAt, and registry URLs.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("Max results per page (default 50, max 200)."),
      offset: z.number().int().min(0).optional().describe("Number of results to skip for pagination (default 0)."),
    }),
  },
  // Registry delete/unpublish operations live under the kind-agnostic
  // extensions_registry_delete / extensions_registry_unpublish tools
  // (registered in the @cinatra-ai/extensions MCP surface alongside
  // extensions_force_delete / extensions_purge).
  // Registry unpublish/delete are package-name+version operations with no
  // kind/DB/disk semantics, so they belong in the extension-lifecycle
  // namespace, not the agent-builder one.
  "agent_version_diff": {
    description: "Return a unified line diff between two snapshots of the same agent template. Both version IDs must belong to the given templateId.",
    inputSchema: z.object({
      templateId: z.string().min(1).describe("ID of the agent template that owns both versions."),
      fromVersionId: z.string().min(1).describe("ID of the earlier (from) version."),
      toVersionId: z.string().min(1).describe("ID of the later (to) version."),
    }),
  },
  "agent_version_get": {
    description: "Retrieve a single agent template version record including its full parsed snapshot.",
    inputSchema: z.object({
      versionId: z.string().min(1).describe("ID of the version to retrieve."),
    }),
  },
  "agent_version_list": {
    description: "List version history for an agent template ordered by versionNumber DESC. Returns { items, total, hasMore, nextCursor? } — pass nextCursor as cursor to fetch the next page.",
    inputSchema: z.object({
      templateId: z.string().min(1).describe("ID of the agent template whose versions to list."),
      limit: z.number().int().min(1).max(100).optional().describe("Max results per page (default 20, max 100)."),
      cursor: z.string().optional().describe("Opaque cursor token from a previous response's nextCursor field. Omit to start from the first page."),
    }),
  },
  "agent_version_rollback": {
    description: "Restore an agent template to a previous version snapshot. Applies the target snapshot to the live template and moves the 'current' version pointer to the target — no new version row is created. The target snapshot row is never mutated. Admin-only.",
    inputSchema: z.object({
      templateId: z.string().min(1).describe("ID of the agent template to roll back."),
      targetVersionId: z.string().min(1).describe("ID of the version to roll back to. Must belong to the given templateId."),
    }),
  },
  "agent_source_list": {
    description:
      "Exploration tool — use before starting the source-authoring pipeline. Lists all agent JSON files in the agents/ directory at the repo root. Returns items[], total. Each item includes path, packageName, packageVersion, name, and description.",
    inputSchema: z.object({}),
  },
  "agent_source_read": {
    description:
      "Exploration tool — use before agent_source_write to inspect the current definition. Reads the OAS Flow file from the canonical source-package directory (currently extensions/cinatra-ai/<packageSlug>/cinatra/oas.json regardless of operator vendor; the disk layout is a separate concern tracked for a future migration). Reads transparently fall back to legacy locations (cinatra/agent.json, then flat agents/<slug>/cinatra/agent.json, then agents/<slug>/agent.json). Returns the parsed content and file path.",
    inputSchema: z.object({
      packageSlug: z
        .string()
        .describe(
          "Directory name under agents/ (e.g. 'email-outreach'). Must not contain path separators.",
        ),
    }),
  },
  "agent_source_write": {
    description:
      "ADMIN-ONLY (platform_admin). Live source mutation: write an OAS Flow 26.1.0 agent definition to the canonical source-package directory (currently extensions/cinatra-ai/<packageSlug>/cinatra/oas.json regardless of operator vendor; the disk layout is a separate concern tracked for a future migration). When a legacy file (agents/<packageSlug>/cinatra/agent.json or agents/<packageSlug>/agent.json) already exists it is overwritten in place. Creates directories and files as needed. The caller is responsible for bumping packageVersion before writing. Source-authoring pipeline step 1 of 5: agent_source_write → agent_source_validate → agent_source_compile → agent_source_publish → agent_run. Non-admin invocations are rejected by both the delegated-chat tool policy and the handler's admin gate; the non-admin proposal→approval workflow runs through a separate `agent_creation_request` store — never these live tools.",
    inputSchema: z.object({
      packageSlug: z
        .string()
        .describe(
          "Directory name under agents/ (e.g. 'my-research-agent'). Must not contain path separators.",
        ),
      content: z
        .string()
        .describe(
          "JSON string of the agent definition (compact OAS v26.1.0 Flow format — agentspec_version, component_type: Flow, nodes, control_flow_connections, $referenced_components).",
        ),
      // Append-only creation-progress emit context.
      // ONLY `runId` is caller-supplied; the notification recipient is ALWAYS
      // server-derived from the request actor (HumanUser only). Unset, or a
      // non-human actor, makes the writing_files progress event a no-op.
      progressContext: z
        .object({
          runId: z
            .string()
            .describe(
              "The chat-dispatch BullMQ runId this write belongs to. The writing_files progress notification is tagged with this runId. Recipient is server-derived from the actor — never caller-controlled.",
            ),
        })
        .optional()
        .describe(
          "Optional append-only progress context. When set together with a HumanUser actor, the handler emits a writing_files progress event after the write preflight passes.",
        ),
    }),
  },
  "agent_source_write_files": {
    description:
      "ADMIN-ONLY (platform_admin). Live source mutation: write the supplementary agent package files — package.json and skills/<packageSlug>/SKILL.md — that agent_source_write does not cover. Files land under the canonical source-package directory, currently extensions/cinatra-ai/<packageSlug>/ (the disk layout is a separate concern tracked for a future migration). The handler normalizes package.json#name to `@<vendorName>/<packageSlug>` defensively, where vendorName is read from `readInstanceIdentity().vendorName` (falling back to `instanceNamespace`, then to `cinatra-ai`). When the rescope changes the name, the response includes a `nameNormalized: { from, to }` hint so callers can correct future writes. Creates directories recursively. Overwrites existing files. Called once per agent creation, or when updating non-oas.json files. Use this together with agent_source_write to scaffold a new agent package from scratch. Non-admin invocations are rejected by both the delegated-chat tool policy and the handler's admin gate; the non-admin proposal→approval workflow runs through a separate store — never these live tools.",
    inputSchema: z.object({
      packageSlug: z
        .string()
        .describe(
          "Directory name under agents/ (e.g. 'email-outreach'). Must not contain path separators.",
        ),
      packageJson: z
        .string()
        .describe(
          "JSON string for package.json (npm manifest with name, version, description, publishConfig).",
        ),
      skillMd: z
        .string()
        .describe(
          "Markdown string for skills/<packageSlug>/SKILL.md (YAML frontmatter + full taskSpec body).",
        ),
      // Append-only creation-progress emit context.
      // ONLY `runId` is caller-supplied; the notification recipient is ALWAYS
      // server-derived from the request actor (HumanUser only). Unset, or a
      // non-human actor, makes the writing_files progress event a no-op.
      progressContext: z
        .object({
          runId: z
            .string()
            .describe(
              "The chat-dispatch BullMQ runId this write belongs to. The writing_files progress notification is tagged with this runId. Recipient is server-derived from the actor — never caller-controlled.",
            ),
        })
        .optional()
        .describe(
          "Optional append-only progress context. When set together with a HumanUser actor, the handler emits a writing_files progress event after the write preflight passes.",
        ),
    }),
  },
  "agent_source_validate": {
    description:
      "Validate an agent JSON object against the OAS v26.1.0 Flow schema (agentspec_version, component_type: Flow, nodes, control_flow_connections, $referenced_components, metadata.cinatra.type). Returns { valid, errors } where errors is an array of human-readable validation messages. Does not write any files. Pass EITHER `content` (JSON string of the definition) OR `packageSlug` (the validator will load oas.json from the package on disk — useful immediately after agent_source_write). Source-authoring pipeline step 2 of 5: agent_source_write → agent_source_validate → agent_source_compile → agent_source_publish → agent_run.",
    inputSchema: z.object({
      content: z
        .string()
        .optional()
        .describe(
          "JSON string of the agent definition to validate. Mutually exclusive with packageSlug — provide one or the other.",
        ),
      packageSlug: z
        .string()
        .optional()
        .describe(
          "Directory name under agents/ (e.g. 'email-test-delivery-agent'). When provided without `content`, validate auto-loads the on-disk oas.json. Must not contain path separators.",
        ),
    }),
  },
  "agent_source_compile": {
    description:
      "ADMIN-ONLY (platform_admin). Live source mutation: recompile the prompt (legacy: taskSpec) of an existing OAS Flow agent at extensions/cinatra-ai/<packageSlug>/cinatra/oas.json (the canonical source-package directory; reads transparently fall back to legacy locations) and write the result back. Updates prompt and type only — all other fields are preserved. Also scans extensions/cinatra-ai/<packageSlug>/skills/ and registers each SKILL.md in the skills catalog via upsertSkill — returns registeredSkillIds with the IDs of all upserted skills. Source-authoring pipeline step 3 of 5: agent_source_write → agent_source_validate → agent_source_compile → agent_source_publish → agent_run. Non-admin invocations are rejected at both the delegated-chat policy and the handler's admin gate (compile syncs into the live agent_templates row by package name); non-admin proposal→approval is a separate, later capability.",
    inputSchema: z.object({
      packageSlug: z
        .string()
        .describe(
          "Directory name under agents/ whose oas.json should be recompiled (e.g. 'my-research-agent'). Must not contain path separators.",
        ),
    }),
  },
  "agent_source_publish": {
    description:
      "Requires the `release_manager` role (gated via the RBAC `marketplace_template::publish` classification); `platform_admin` is a superset bypass. Live source mutation: publish an agent directly from its on-disk source-package directory (currently extensions/cinatra-ai/<packageSlug>/ regardless of operator vendor; the disk layout is a separate concern tracked for a future migration) to Verdaccio. Reads the canonical package name and version from package.json in that directory — the package name's scope IS vendor-aware (the operator's `instanceNamespace`), set by `agent_source_write_files`. Refuses to overwrite an already-published version (returns alreadyPublished: true instead). Returns packageName, packageVersion, registryUrl, published, alreadyPublished, plus detailPath — the canonical workspace URL (e.g. `/agents/<vendor>/<slug>/new` — the workspace route IS vendor-scoped) callers should use verbatim when linking the published agent. Never compose the URL from packageName yourself. Source-authoring pipeline step 4 of 5: agent_source_write → agent_source_validate → agent_source_compile → agent_source_publish → agent_run. Authorized via the `requireAccess` primitive (an `audit_events` row is written on both allow and deny); the delegated-chat policy still restricts the chat surface. Non-`release_manager`/non-admin invocations are rejected; non-admin proposal→approval is a separate, later capability.",
    inputSchema: z.object({
      packageSlug: z
        .string()
        .describe(
          "Directory name under agents/ (e.g. 'email-outreach'). Must not contain path separators.",
        ),
      changelog: z.string().optional().describe("Optional changelog note for this release."),
      // Publish destination (private | public). Defaults to "private".
      // The handler resolves the destination before calling
      // publishAgentPackageFromGitDir.
      destination: z
        .enum(["private", "public"])
        .default("private")
        .optional()
        .describe(
          "Publish destination: 'private' (instance-only, default) or 'public' (Cinatra marketplace).",
        ),
      // License detection gate.
      // When the package has a copyleft license, the handler throws
      // LicenseAcknowledgementRequiredError. Callers must re-submit with
      // licenseAcknowledged: true after showing the LicenseWarningDialog.
      licenseAcknowledged: z
        .boolean()
        .optional()
        .describe(
          "Set to true after user acknowledges a copyleft license in the LicenseWarningDialog. Required when package has a copyleft license (GPL/AGPL/LGPL/MPL-2.0).",
        ),
    }),
  },
  // ----------------------------------------------------------------------
  // WORKFLOW declarative package-authoring (SDK-P5, eng#167).
  //
  // These author a workflow EXTENSION PACKAGE (a `cinatra.kind: "workflow"`
  // package with a `cinatra/workflow.bpmn` definition), published to the
  // registry. They are FUNDAMENTALLY DISTINCT from the `workflow_draft_*` /
  // `workflow_template_*` runtime tools (the @cinatra-ai/workflows MCP surface)
  // which create/edit a workflow DRAFT or INSTANCE (rows in the `workflow`
  // table). Package vs draft: a package is reusable, versioned, and shippable;
  // a draft is one operator's concrete planned-run on the Gantt. ADMIN-ONLY.
  // ----------------------------------------------------------------------
  "workflow_source_write": {
    description:
      "ADMIN-ONLY (platform_admin). Live source mutation: scaffold + write a WORKFLOW EXTENSION PACKAGE to extensions/cinatra-ai/<packageSlug>/ — package.json (cinatra.kind is normalized to \"workflow\"), cinatra/workflow.bpmn (the declarative BPMN definition), and an optional skills/<packageSlug>/SKILL.md. DISTINCT from workflow_draft_create / workflow_template_instantiate, which author a workflow DRAFT/INSTANCE row (a planned run on the Gantt) — NOT a reusable package. Validates the BPMN before writing (fails closed on a structurally-invalid workflow) and normalizes package.json#name to @<vendorName>/<packageSlug>. Source-authoring pipeline step 1 of 4: workflow_source_write → workflow_source_validate → workflow_source_compile → workflow_source_publish. Non-admin invocations are rejected by the delegated-chat tool policy and the handler's admin gate.",
    inputSchema: z.object({
      packageSlug: z
        .string()
        .describe("Directory name under extensions/cinatra-ai/ (e.g. 'product-launch-workflow'). Must not contain path separators. Convention: kind at the END (-workflow)."),
      packageJson: z
        .string()
        .describe("JSON string for package.json (npm manifest; cinatra.kind is normalized to \"workflow\", workflowVersion defaults to 1 when absent)."),
      workflowBpmn: z
        .string()
        .describe("BPMN XML string for cinatra/workflow.bpmn — the declarative workflow definition (cinatra: namespace extension elements for taskKind/schedule/agentRef/approvalConfig)."),
      skillMd: z
        .string()
        .optional()
        .describe("Optional Markdown string for skills/<packageSlug>/SKILL.md (authoring/usage notes for the workflow package)."),
      progressContext: z
        .object({ runId: z.string() })
        .optional()
        .describe("Append-only creation-progress emit context; recipient is server-derived from the actor (HumanUser only)."),
    }),
  },
  "workflow_source_validate": {
    description:
      "Validate a workflow.bpmn (a workflow PACKAGE's declarative definition) — parses the BPMN sidecar to a WorkflowSpec and validates it at the template tier. Returns { valid, errors } where errors are human-readable. Does NOT write or persist anything, and does NOT touch any workflow DRAFT/INSTANCE row (that is workflow_validate on the runtime surface). Pass EITHER `content` (BPMN XML string) OR `packageSlug` (loads cinatra/workflow.bpmn from the package on disk). Source-authoring pipeline step 2 of 4.",
    inputSchema: z.object({
      content: z.string().optional().describe("BPMN XML string of the workflow definition."),
      packageSlug: z.string().optional().describe("Package slug to load cinatra/workflow.bpmn from disk. Must not contain path separators."),
    }),
  },
  "workflow_source_compile": {
    description:
      "ADMIN-ONLY (platform_admin). Build/verify gate for a workflow PACKAGE: re-validates that the on-disk cinatra/workflow.bpmn parses + validates as a template and runs the sibling-file credential scan. A workflow package is purely declarative — unlike agent_source_compile there is NO agent_templates DB sync. Returns { compiled, valid }. Source-authoring pipeline step 3 of 4. Non-admin invocations are rejected at the delegated-chat policy and the handler's admin gate.",
    inputSchema: z.object({
      packageSlug: z.string().describe("Workflow package slug. Must not contain path separators."),
    }),
  },
  "workflow_source_publish": {
    description:
      "ADMIN-ONLY (platform_admin). Live source mutation: publish a WORKFLOW PACKAGE from its on-disk directory (extensions/cinatra-ai/<packageSlug>/) to the configured registry. Reads name + version from package.json, carries the declarative cinatra block (kind=workflow) through to the published manifest, and re-runs the BPMN validation gate before publishing. Refuses to overwrite an already-published version (returns alreadyPublished: true). Does NOT publish a workflow DRAFT/INSTANCE (those never leave the instance). Source-authoring pipeline step 4 of 4. Non-admin invocations are rejected by the delegated-chat tool policy and the handler's admin gate.",
    inputSchema: z.object({
      packageSlug: z.string().describe("Workflow package slug. Must not contain path separators."),
      changelog: z.string().nullable().optional().describe("Optional changelog note for this release."),
      destination: z
        .enum(["private", "public"])
        .default("private")
        .optional()
        .describe("Publish destination: 'private' (instance-only, default) or 'public' (Cinatra marketplace)."),
      licenseAcknowledged: z
        .boolean()
        .optional()
        .describe("Set to true after the user acknowledges a copyleft license. Required when the package has a copyleft license (GPL/AGPL/LGPL/MPL-2.0)."),
    }),
  },
  // Single review surface for chat-driven agent authoring.
  // Deterministic lint runs server-side; advisory mode is DEFERRED because
  // agent_run queues asynchronously and cannot return helper findings inline.
  // Advisory mode returns the deterministic findings plus one
  // suggestion-severity `advisory_dispatch_deferred` marker per helper that
  // WOULD have dispatched; `ranAdvisoryAgents` is always []. Deterministic
  // blockers gate agent_source_compile and agent_source_publish.
  // `agent_creation_review` replaces the broken
// `@cinatra/agent-creation-finalizer` Flow with a deterministic MCP primitive
// that calls the 4 review lanes (lint + 3 LLM advisors) in-process and
// aggregates via the shared merge helper. Chat-runner: prefer this over
// `agent_run @cinatra/agent-creation-finalizer` because A2A for internal
// sub-agent composition is forbidden.
"agent_creation_review": {
    description:
      "Deterministic chat-authoring review primitive. Runs the 4 review lanes (lint-policy + agent-security-reviewer + agent-code-reviewer + agent-planner) in-process and returns a single bucketed report: { ok, blockers, warnings, suggestions, findings, ranAdvisoryAgents }. The lint lane runs every deterministic scanner (literal credentials, untrusted URLs, /api/llm-bridge wiring, runtime invariants OAS-RUNTIME-001..008). The 3 LLM advisor lanes run in parallel via runDeterministicLlmTask using the reviewer agents' own system prompts (loaded from extensions/cinatra-ai/<slug>/cinatra/oas.json at call time — no hardcoded prompts). Blockers prevent agent_source_compile and agent_source_publish. Replaces the agent-creation-finalizer Flow because A2A for internal sub-agent composition is forbidden per OAS-RUNTIME-008.",
    inputSchema: z.object({
      oasJson: z
        .string()
        .describe(
          "Raw JSON string of the OAS Flow body being reviewed. Required.",
        ),
      packageJson: z
        .string()
        .optional()
        .describe(
          "Optional sibling package.json string. Reserved for future scanners that need package metadata; currently ignored.",
        ),
      packageSlug: z
        .string()
        .optional()
        .describe(
          "Optional slug for context labelling in the rendered findings. Purely informational — does not affect blocker decisions.",
        ),
      reviewContext: z
        .string()
        .optional()
        .describe(
          "Optional free-form JSON-string context the chat assistant wants the LLM reviewers to see (e.g. recent edits, user intent). Substituted into each reviewer's `{{ reviewContext }}` placeholder.",
        ),
      // Append-only creation-progress emit context.
      // ONLY `runId` is caller-supplied. The notification recipient is ALWAYS
      // server-derived from the request actor (HumanUser only); a non-human
      // actor or unset progressContext makes every progress event a no-op.
      // Callers CANNOT fan notifications out to other users/teams/orgs/projects
      // via this field.
      progressContext: z
        .object({
          runId: z
            .string()
            .describe(
              "The chat-dispatch BullMQ runId this review belongs to. Progress notifications are tagged with this runId for the inline creation timeline. Recipient is server-derived from the actor — never caller-controlled.",
            ),
        })
        .optional()
        .describe(
          "Optional append-only progress context. When set together with a HumanUser actor, the handler emits creation-progress events tagged with progressContext.runId.",
        ),
    }),
  },

  "agent_source_review": {
    description:
      "Single review surface for chat-driven agent authoring. Runs deterministic lint (literal credentials, untrusted URLs, /api/llm-bridge wiring) and returns { blockers, warnings, suggestions, ranAdvisoryAgents }. In 'advisory' mode, emits an `advisory_dispatch_deferred` suggestion per helper that would have run because synchronous helper-execution wiring is not available. ranAdvisoryAgents is always [] in advisory mode. Blockers prevent agent_source_compile and agent_source_publish.",
    inputSchema: z
      .object({
        packageSlug: z
          .string()
          .optional()
          .describe(
            "Directory name under agents/<root>/<packageSlug>/. Mutually exclusive with content.",
          ),
        content: z
          .string()
          .optional()
          .describe(
            "JSON string of the OAS to review. Mutually exclusive with packageSlug.",
          ),
        reviewMode: z
          .enum(["deterministic", "advisory"])
          .describe(
            "'deterministic' runs the server-side lint only. 'advisory' runs the lint and emits deferred-marker suggestions for the helper agents that would have dispatched if synchronous helper execution were wired; ranAdvisoryAgents is always [] while that wiring is unavailable.",
          ),
      })
      .refine(
        (v) => (v.packageSlug !== undefined) !== (v.content !== undefined),
        { message: "Provide exactly one of packageSlug or content." },
      ),
  },
  // Field collection is handled by per-field AG-UI INTERRUPT events at run time,
  // so no MCP primitive is needed for the assist loop.

  // Trigger configuration MCP primitives.
  // Wraps the actor-aware trigger-service.ts via mcp/handlers.ts; same
  // enforcement code path as the run-actions.ts server actions used by the UI.
  "agent_run_trigger_set": {
    description:
      "Configure the side-effects trigger gate for a run. Trigger types: 'immediate' (gate opens at run start), 'scheduled' (one-shot at scheduledAt), 'recurring' (cron). Side-effects-marked steps are blocked until the trigger fires.",
    inputSchema: z.object({
      runId: z.string().describe("ID of the run to configure."),
      triggerType: z.enum(["immediate", "scheduled", "recurring"]),
      scheduledAt: z
        .string()
        .datetime()
        .optional()
        .describe(
          "ISO datetime when scheduled triggers fire. Required for triggerType='scheduled'.",
        ),
      cronExpression: z.string().max(256)
        .optional()
        .describe(
          "Cron expression (5-field). Required for triggerType='recurring'. Max 256 chars.",
        ),
      timezone: z
        .string()
        .default("UTC")
        .describe(
          "IANA timezone name (e.g. 'Europe/London'). Defaults to 'UTC'.",
        ),
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "If false, the trigger row exists but does NOT fire. Use to pause a recurring trigger without losing config.",
        ),
    }),
  },
  "agent_run_trigger_get": {
    description: "Get the trigger configuration for a run.",
    inputSchema: z.object({
      runId: z.string().describe("ID of the run."),
    }),
  },
  "agent_run_trigger_delete": {
    description:
      "Remove the trigger for a run. Cancels any scheduled BullMQ job. The run remains in its current status.",
    inputSchema: z.object({
      runId: z.string().describe("ID of the run."),
    }),
  },
  "agent_creation_request_propose": {
    description:
      "NON-ADMIN proposal entry for the agent-creation approval workflow. Captures the agent " +
      "OAS + package.json + SKILL.md as an isolated agent_creation_request row at status 'proposed' " +
      "and runs the existing agent_creation_review to populate review_report. NEVER calls live " +
      "agent_source_* tools or touches agent_templates. An admin reviews + approves at " +
      "/configuration/agents/approvals; only on approval does the existing gated publish run " +
      "(private-scoped, under the admin's actor frame).",
    inputSchema: z
      .object({
        packageSlug: z.string().describe("On-disk slug (no path separators)."),
        packageName: z.string().describe("@scope/name. Must NOT collide with an existing agent_template."),
        packageVersion: z.string().describe("Semver."),
        oas: z.unknown().describe("OAS Flow 26.1.0 object."),
        packageJson: z.unknown().describe("package.json object."),
        skillMd: z.string().nullable().optional().describe("Optional SKILL.md content."),
      })
      .strict(),
  },
  "agent_creation_request_edit": {
    description:
      "Author re-snapshots a REJECTED agent creation request and resubmits. Reruns the review and " +
      "transitions the row back to 'proposed' with a fresh snapshot_hash (the CAS guard is reset).",
    inputSchema: z
      .object({
        id: z.string().describe("agent_creation_request id."),
        packageVersion: z.string().optional(),
        oas: z.unknown().optional(),
        packageJson: z.unknown().optional(),
        skillMd: z.string().nullable().optional(),
      })
      .strict(),
  },
  "agent_creation_request_list": {
    description:
      "List agent creation requests. Non-admin: own requests only. Admin: all org requests.",
    inputSchema: z
      .object({
        status: z
          .enum(["draft", "proposed", "approved", "rejected", "published", "all"])
          .optional(),
        authorId: z.string().optional().describe("Admin-only filter."),
      })
      .strict(),
  },
  "agent_creation_request_get": {
    description: "Read one agent creation request by id (author or admin).",
    inputSchema: z.object({ id: z.string() }).strict(),
  },
  "agent_creation_request_decide": {
    description:
      "ADMIN-ONLY decide (CAS on snapshot_hash). Approve dispatches the existing gated publish " +
      "under the approving admin's actor frame (private-scoped, hard-rejects on " +
      "package-name collision); reject records the reason. Self-approval is disallowed by default " +
      "(override via connector_config.agent_creation.allowSelfApproval=true). NOT on the " +
      "delegated-chat allowlist by design — admin acts via the /configuration/agents/approvals UI.",
    inputSchema: z
      .object({
        id: z.string(),
        decision: z.enum(["approve", "reject"]),
        reason: z.string().optional(),
        expectedSnapshotHash: z.string().describe("CAS: must match the row's current snapshot_hash."),
      })
      .strict(),
  },
  "agent_creation_request_retry_publish": {
    description:
      "ADMIN-ONLY retry for a stuck-`approved` row (CAS-to-approved succeeded but the materialize/" +
      "publish step errored). Re-attempts materialize + publish under the admin actor without a " +
      "second decide (same snapshot). NOT on the delegated-chat allowlist by design.",
    inputSchema: z.object({ id: z.string() }).strict(),
  },
};

// ---------------------------------------------------------------------------
// Agents-only MCP tool metadata (merged from packages/agents thin layer)
// ---------------------------------------------------------------------------

export const AGENTS_TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "agents_list": {
    description: "List all agents: cinatra-built agent templates with activity (ran or setup started) and all code agent instances (scrape, research, enrichment, ross-index, transcript, campaigns).",
    inputSchema: z.object({}),
  },
};
