/**
 * Curated classification overlay on the machine-emitted
 * inventory at `__generated__/inventory.json`.
 *
 * The generated JSON is the source of truth for which primitives EXIST; this
 * file is the source of truth for what each one ACCESSES. Test coverage
 * asserts every generated primitive has a
 * classification entry here AND every entry's `(resourceType, action)`
 * exists in the central registry (`registry.ts`).
 *
 * Classifications are declarative metadata consumed at the tool dispatch
 * boundary.
 */

import type { Action } from "./registry";
import type { ResourceType } from "./resource-ref";

export type EnforcementStatus = "enforced" | "partial" | "unenforced";

export type PrimitiveClassification = {
  resourceType: ResourceType;
  action: Action;
  /** Every entry starts "unenforced" and flips to "enforced" when dispatch enforcement lands. */
  status: EnforcementStatus;
};

// ---------------------------------------------------------------------------
// CLASSIFICATIONS — keyed by primitive name. KEEP ALPHABETICAL by key.
// ---------------------------------------------------------------------------

export const PRIMITIVE_CLASSIFICATIONS: Record<string, PrimitiveClassification> = {
  // ───── entity_account ─────
  accounts_create: { resourceType: "entity_account", action: "create", status: "enforced" },
  accounts_delete: { resourceType: "entity_account", action: "delete", status: "enforced" },
  accounts_get:    { resourceType: "entity_account", action: "read",   status: "enforced" },
  accounts_list:   { resourceType: "entity_account", action: "list",   status: "enforced" },
  accounts_update: { resourceType: "entity_account", action: "update", status: "enforced" },

  // ───── agent / agents ─────
  agent_compile:                { resourceType: "agent", action: "update",  status: "enforced" },
  agent_delete:                 { resourceType: "agent", action: "delete",  status: "enforced" },
  agent_export:                 { resourceType: "agent", action: "read",    status: "enforced" },
  agent_get:                    { resourceType: "agent", action: "read",    status: "enforced" },
  agent_import:                 { resourceType: "agent", action: "create",  status: "enforced" },
  agent_list:                   { resourceType: "agent", action: "list",    status: "enforced" },
  agent_registry_list:          { resourceType: "agent", action: "list",    status: "enforced" },
  agent_registry_publish:       { resourceType: "agent", action: "share",   status: "enforced" },
  agent_save:                   { resourceType: "agent", action: "update",  status: "enforced" },
  agent_source_compile:         { resourceType: "agent", action: "update",  status: "enforced" },
  agent_source_list:            { resourceType: "agent", action: "list",    status: "enforced" },
  agent_source_publish:         { resourceType: "agent", action: "share",   status: "enforced" },
  agent_source_read:            { resourceType: "agent", action: "read",    status: "enforced" },
  agent_source_review:          { resourceType: "agent", action: "read",    status: "enforced" },
  agent_source_validate:        { resourceType: "agent", action: "read",    status: "enforced" },
  agent_source_write:           { resourceType: "agent", action: "update",  status: "enforced" },
  agent_source_write_files:     { resourceType: "agent", action: "update",  status: "enforced" },
  agent_template_duplicate:     { resourceType: "agent", action: "create",  status: "enforced" },
  agent_update:                 { resourceType: "agent", action: "update",  status: "enforced" },
  agent_version_diff:           { resourceType: "agent", action: "read",    status: "enforced" },
  agent_version_get:            { resourceType: "agent", action: "read",    status: "enforced" },
  agent_version_list:           { resourceType: "agent", action: "list",    status: "enforced" },
  agent_version_rollback:       { resourceType: "agent", action: "update",  status: "enforced" },
  agents_list:                  { resourceType: "agent", action: "list",    status: "enforced" },

  // ───── agent_creation_request ─────
  agent_creation_request_propose:       { resourceType: "agent", action: "create",  status: "enforced" },
  agent_creation_request_edit:          { resourceType: "agent", action: "update",  status: "enforced" },
  agent_creation_request_list:          { resourceType: "agent", action: "list",    status: "enforced" },
  agent_creation_request_get:           { resourceType: "agent", action: "read",    status: "enforced" },
  agent_creation_request_decide:        { resourceType: "agent", action: "share",   status: "enforced" },
  agent_creation_request_retry_publish: { resourceType: "agent", action: "share",   status: "enforced" },

  // ───── agent_run ─────
  agent_run:                       { resourceType: "agent_run", action: "create",  status: "enforced" },
  agent_run_get:                   { resourceType: "agent_run", action: "read",    status: "enforced" },
  agent_run_list:                  { resourceType: "agent_run", action: "list",    status: "enforced" },
  agent_run_messages_list:         { resourceType: "agent_run", action: "read",    status: "enforced" },
  agent_run_move_with_outputs:     { resourceType: "agent_run", action: "update",  status: "enforced" },
  agent_run_resume:                { resourceType: "agent_run", action: "execute", status: "enforced" },
  agent_run_stop:                  { resourceType: "agent_run", action: "cancel",  status: "enforced" },
  agent_run_trigger_delete:        { resourceType: "trigger",   action: "delete",  status: "enforced" },
  agent_run_trigger_get:           { resourceType: "trigger",   action: "read",    status: "enforced" },
  agent_run_trigger_set:           { resourceType: "trigger",   action: "create",  status: "enforced" },
  agent_run_update:                { resourceType: "agent_run", action: "update",  status: "enforced" },
  agent_runs_stop:                 { resourceType: "agent_run", action: "cancel",  status: "enforced" },

  // ───── apollo (connector_instance) ─────
  apollo_administration_get:     { resourceType: "connector_instance", action: "admin",   status: "enforced" },
  apollo_administration_logging: { resourceType: "connector_instance", action: "admin",   status: "enforced" },
  apollo_jobs_execution_run:     { resourceType: "connector_instance", action: "execute", status: "enforced" },
  apollo_jobs_optimization_run:  { resourceType: "connector_instance", action: "execute", status: "enforced" },
  apollo_people_search:          { resourceType: "connector_instance", action: "execute", status: "enforced" },
  apollo_status:                 { resourceType: "connector_instance", action: "read",    status: "enforced" },
  apollo_validate:               { resourceType: "connector_instance", action: "read",    status: "enforced" },

  // ───── artifact ─────
  artifact_assertion_get:           { resourceType: "artifact", action: "read",   status: "enforced" },
  artifact_assertion_list:          { resourceType: "artifact", action: "list",   status: "enforced" },
  artifact_authoring_chain_get:     { resourceType: "artifact", action: "read",   status: "enforced" },
  artifact_authoring_emit:          { resourceType: "artifact", action: "create", status: "enforced" },
  artifact_extension_get:           { resourceType: "artifact", action: "read",   status: "enforced" },
  artifact_extension_search:        { resourceType: "artifact", action: "list",   status: "enforced" },
  artifact_representation_get:      { resourceType: "artifact", action: "read",   status: "enforced" },
  artifact_representation_latest:   { resourceType: "artifact", action: "read",   status: "enforced" },
  artifact_representation_list:     { resourceType: "artifact", action: "list",   status: "enforced" },
  artifacts_get:                    { resourceType: "artifact", action: "read",   status: "enforced" },
  artifacts_list:                   { resourceType: "artifact", action: "list",   status: "enforced" },
  artifacts_tombstone:              { resourceType: "artifact", action: "delete", status: "enforced" },

  // ───── blog (artifact + connector_instance + agent_run) ─────
  blog_connector_list:                       { resourceType: "connector_instance", action: "list",    status: "enforced" },
  blog_image_generate_cancel:                { resourceType: "agent_run",          action: "cancel",  status: "enforced" },
  blog_image_generate_start:                 { resourceType: "agent_run",          action: "create",  status: "enforced" },
  blog_media_image_save:                     { resourceType: "artifact",           action: "create",  status: "enforced" },
  blog_media_list:                           { resourceType: "artifact",           action: "list",    status: "enforced" },
  blog_personal_skill_create:                { resourceType: "skill",              action: "create",  status: "enforced" },
  blog_post_generate_cancel:                 { resourceType: "agent_run",          action: "cancel",  status: "enforced" },
  blog_post_generate_start:                  { resourceType: "agent_run",          action: "create",  status: "enforced" },
  blog_post_ideas_generate_cancel:           { resourceType: "agent_run",          action: "cancel",  status: "enforced" },
  blog_post_ideas_generate_start:            { resourceType: "agent_run",          action: "create",  status: "enforced" },
  blog_post_publish_linkedin_cancel:         { resourceType: "agent_run",          action: "cancel",  status: "enforced" },
  blog_post_publish_linkedin_publish:        { resourceType: "agent_run",          action: "create",  status: "enforced" },
  blog_post_publish_linkedin_publish_cancel: { resourceType: "agent_run",          action: "cancel",  status: "enforced" },
  blog_post_publish_linkedin_start:          { resourceType: "agent_run",          action: "create",  status: "enforced" },
  blog_post_publish_linkedin_update:         { resourceType: "agent_run",          action: "update",  status: "enforced" },
  blog_post_publish_wordpress_cancel:        { resourceType: "agent_run",          action: "cancel",  status: "enforced" },
  blog_post_publish_wordpress_delete:        { resourceType: "artifact",           action: "delete",  status: "enforced" },
  blog_post_publish_wordpress_start:         { resourceType: "agent_run",          action: "create",  status: "enforced" },
  blog_post_publish_wordpress_status:        { resourceType: "agent_run",          action: "read",    status: "enforced" },
  blog_post_update:                          { resourceType: "artifact",           action: "update",  status: "enforced" },
  blog_project_create:                       { resourceType: "project",            action: "create",  status: "enforced" },
  blog_project_get:                          { resourceType: "project",            action: "read",    status: "enforced" },
  blog_project_list:                         { resourceType: "project",            action: "list",    status: "enforced" },
  blog_transcripts_list:                     { resourceType: "artifact",           action: "list",    status: "enforced" },
  blog_wordpress_content_convert:            { resourceType: "artifact",           action: "update",  status: "enforced" },

  // ───── chat ─────
  chat_mentions_poll:   { resourceType: "notification", action: "list",   status: "enforced" },
  chat_thread_get:      { resourceType: "object",       action: "read",   status: "enforced" },
  chat_thread_list:     { resourceType: "object",       action: "list",   status: "enforced" },
  chat_thread_send:     { resourceType: "object",       action: "create", status: "enforced" },
  chat_thread_update:   { resourceType: "object",       action: "update", status: "enforced" },

  // ───── dashboard ─────
  dashboards_archive:         { resourceType: "dashboard", action: "delete", status: "enforced" },
  dashboards_create:          { resourceType: "dashboard", action: "create", status: "enforced" },
  dashboards_cube_chart:      { resourceType: "dashboard", action: "read",   status: "enforced" },
  dashboards_cube_discover:   { resourceType: "dashboard", action: "list",   status: "enforced" },
  dashboards_cube_load:       { resourceType: "dashboard", action: "read",   status: "enforced" },
  dashboards_cube_validate:   { resourceType: "dashboard", action: "read",   status: "enforced" },
  dashboards_get:             { resourceType: "dashboard", action: "read",   status: "enforced" },
  dashboards_list:            { resourceType: "dashboard", action: "list",   status: "enforced" },
  dashboards_publish:         { resourceType: "dashboard", action: "update", status: "enforced" },
  dashboards_update:          { resourceType: "dashboard", action: "update", status: "enforced" },

  // ───── list ─────
  // lists_* MCP primitives retired. Classification stripped so the
  // inventory regenerator drops them and the drift / parity tests pass
  // against the empty registry. Replacements live on the provider-agnostic
  // CRM facade (crm_list_* family in
  // extensions/cinatra-ai/crm-connector/src/mcp/module.ts).

  // ───── entity_contact ─────
  contacts_create:        { resourceType: "entity_contact", action: "create", status: "enforced" },
  contacts_delete:        { resourceType: "entity_contact", action: "delete", status: "enforced" },
  contacts_get:           { resourceType: "entity_contact", action: "read",   status: "enforced" },
  contacts_list:          { resourceType: "entity_contact", action: "list",   status: "enforced" },
  contacts_sources_list:  { resourceType: "entity_contact", action: "list",   status: "enforced" },
  contacts_update:        { resourceType: "entity_contact", action: "update", status: "enforced" },

  // ───── context (artifact) ─────
  context_list_eligible_assertions: { resourceType: "artifact", action: "list", status: "enforced" },
  context_resolve:                  { resourceType: "artifact", action: "read", status: "enforced" },

  // ───── crm (connector_instance) ─────
  crm_account_create:        { resourceType: "connector_instance", action: "execute", status: "enforced" },
  crm_account_get:           { resourceType: "connector_instance", action: "read",    status: "enforced" },
  crm_account_search:        { resourceType: "connector_instance", action: "list",    status: "enforced" },
  crm_account_update:        { resourceType: "connector_instance", action: "execute", status: "enforced" },
  crm_contact_create:        { resourceType: "connector_instance", action: "execute", status: "enforced" },
  crm_contact_find_by_email: { resourceType: "connector_instance", action: "read",    status: "enforced" },
  crm_contact_get:           { resourceType: "connector_instance", action: "read",    status: "enforced" },
  crm_contact_search:        { resourceType: "connector_instance", action: "list",    status: "enforced" },
  crm_contact_update:        { resourceType: "connector_instance", action: "execute", status: "enforced" },
  crm_list_create:           { resourceType: "connector_instance", action: "execute", status: "enforced" },
  crm_list_get:              { resourceType: "connector_instance", action: "read",    status: "enforced" },
  crm_list_member_add:       { resourceType: "connector_instance", action: "execute", status: "enforced" },
  crm_list_member_remove:    { resourceType: "connector_instance", action: "execute", status: "enforced" },
  crm_list_members_get:      { resourceType: "connector_instance", action: "read",    status: "enforced" },
  crm_list_search:           { resourceType: "connector_instance", action: "list",    status: "enforced" },

  // ───── drupal (connector_instance) ─────
  drupal_content_editor_run:          { resourceType: "connector_instance", action: "execute", status: "enforced" },
  drupal_instances_list:              { resourceType: "connector_instance", action: "list",    status: "enforced" },
  drupal_node_create_draft_revision:  { resourceType: "connector_instance", action: "execute", status: "enforced" },
  drupal_node_get:                    { resourceType: "connector_instance", action: "execute", status: "enforced" },
  drupal_node_list:                   { resourceType: "connector_instance", action: "execute", status: "enforced" },
  drupal_node_publish:                { resourceType: "connector_instance", action: "execute", status: "enforced" },
  drupal_node_update:                 { resourceType: "connector_instance", action: "execute", status: "enforced" },
  drupal_status:                      { resourceType: "connector_instance", action: "read",    status: "enforced" },

  // ───── email ─────
  email_send: { resourceType: "connector_instance", action: "execute", status: "enforced" },

  // ───── extensions ─────
  extensions_archive:             { resourceType: "extension_registry", action: "uninstall", status: "enforced" },
  extensions_force_delete:        { resourceType: "extension_registry", action: "uninstall", status: "enforced" },
  extensions_install:             { resourceType: "extension_registry", action: "install",   status: "enforced" },
  extensions_purge:               { resourceType: "extension_registry", action: "uninstall", status: "enforced" },
  extensions_purge_execute:       { resourceType: "extension_registry", action: "uninstall", status: "enforced" },
  extensions_registry_delete:     { resourceType: "extension_registry", action: "uninstall", status: "enforced" },
  extensions_registry_unpublish:  { resourceType: "extension_registry", action: "uninstall", status: "enforced" },
  extensions_restore:             { resourceType: "extension_registry", action: "install",   status: "enforced" },
  extensions_search:              { resourceType: "extension_registry", action: "list",      status: "enforced" },
  extensions_uninstall:           { resourceType: "extension_registry", action: "uninstall", status: "enforced" },
  extensions_update:              { resourceType: "extension_registry", action: "install",   status: "enforced" },

  // ───── gmail (connector_instance) ─────
  gmail_aliases_list:    { resourceType: "connector_instance", action: "list",    status: "enforced" },
  gmail_aliases_refresh: { resourceType: "connector_instance", action: "execute", status: "enforced" },
  gmail_email_find_reply:{ resourceType: "connector_instance", action: "execute", status: "enforced" },
  gmail_email_send:      { resourceType: "connector_instance", action: "execute", status: "enforced" },
  gmail_status:          { resourceType: "connector_instance", action: "read",    status: "enforced" },

  // ───── google_calendar (connector_instance) ─────
  google_calendar_appointments_list: { resourceType: "connector_instance", action: "execute", status: "enforced" },

  // ───── linkedin (connector_instance) ─────
  linkedin_accounts_list:     { resourceType: "connector_instance", action: "list",    status: "enforced" },
  linkedin_destinations_list: { resourceType: "connector_instance", action: "list",    status: "enforced" },
  linkedin_post_publish:      { resourceType: "connector_instance", action: "execute", status: "enforced" },
  linkedin_status:            { resourceType: "connector_instance", action: "read",    status: "enforced" },

  // ───── media_feeds (connector_instance) ─────
  media_feed_podcast_list:  { resourceType: "connector_instance", action: "execute", status: "enforced" },
  media_feed_youtube_list:  { resourceType: "connector_instance", action: "execute", status: "enforced" },

  // ───── metric_cost ─────
  metric_cost_budget_get:     { resourceType: "metric_cost", action: "read", status: "enforced" },
  metric_cost_by_agent:       { resourceType: "metric_cost", action: "read", status: "enforced" },
  metric_cost_by_provider:    { resourceType: "metric_cost", action: "read", status: "enforced" },
  metric_cost_recent_events:  { resourceType: "metric_cost", action: "list", status: "enforced" },
  metric_cost_summary:        { resourceType: "metric_cost", action: "read", status: "enforced" },
  metric_cost_timeseries:     { resourceType: "metric_cost", action: "read", status: "enforced" },

  // ───── metric_usage ─────
  metric_usage_events:  { resourceType: "metric_usage", action: "list", status: "enforced" },
  metric_usage_summary: { resourceType: "metric_usage", action: "read", status: "enforced" },

  // ───── object ─────
  objects_classify:      { resourceType: "object", action: "update", status: "enforced" },
  objects_delete:        { resourceType: "object", action: "delete", status: "enforced" },
  objects_get:           { resourceType: "object", action: "read",   status: "enforced" },
  objects_list:          { resourceType: "object", action: "list",   status: "enforced" },
  objects_save:          { resourceType: "object", action: "create", status: "enforced" },
  objects_type_register: { resourceType: "object", action: "create", status: "enforced" },
  objects_types_list:    { resourceType: "object", action: "list",   status: "enforced" },
  objects_update:        { resourceType: "object", action: "update", status: "enforced" },

  // ───── object history / data-safety ─────
  // status:"unenforced" — these defer to per-handler authz (org guard +
  // per-EVENT read redaction + current-actor restore authz + platform_admin
  // on retry), which the coarse boundary gate cannot express. Classifying them
  // (vs leaving them unclassified) is what makes the data-safety MCP surface
  // reachable by authorized direct callers at all (enforceMcpBoundary blocks
  // unclassified primitives) — the change_set_*/object_* primitives must be
  // classified here to be reachable.
  change_set_eligibility_get:                  { resourceType: "object", action: "read",   status: "unenforced" },
  change_set_get:                              { resourceType: "object", action: "read",   status: "unenforced" },
  change_set_list:                             { resourceType: "object", action: "list",   status: "unenforced" },
  change_set_undo:                             { resourceType: "object", action: "update", status: "unenforced" },
  freshness_check_for_change_set:              { resourceType: "object", action: "read",   status: "unenforced" },
  object_history_list:                         { resourceType: "object", action: "read",   status: "unenforced" },
  object_version_restore:                      { resourceType: "object", action: "update", status: "unenforced" },
  remote_effect_attempt_retry:                 { resourceType: "object", action: "update", status: "unenforced" },
  remote_effect_attempts_list_for_change_set:  { resourceType: "object", action: "read",   status: "unenforced" },

  // ───── permissions (administration / organization-membership) ─────
  permissions_invitations_cancel:           { resourceType: "administration", action: "update", status: "enforced" },
  permissions_members_invite:               { resourceType: "administration", action: "update", status: "enforced" },
  permissions_members_remove:               { resourceType: "administration", action: "update", status: "enforced" },
  permissions_members_update_role:          { resourceType: "administration", action: "update", status: "enforced" },
  permissions_users_update_platform_role:   { resourceType: "administration", action: "update", status: "enforced" },
  // role_grant CRUD primitives.
  role_grant_grant:                         { resourceType: "administration", action: "update", status: "enforced" },
  role_grant_revoke:                        { resourceType: "administration", action: "update", status: "enforced" },
  role_grant_list:                          { resourceType: "administration", action: "read",   status: "enforced" },

  // ───── project ─────
  project_access_check:                       { resourceType: "project", action: "read",   status: "enforced" },
  project_access_grant:                       { resourceType: "project", action: "update", status: "enforced" },
  project_access_list:                        { resourceType: "project", action: "read",   status: "enforced" },
  project_access_revoke:                      { resourceType: "project", action: "update", status: "enforced" },
  project_agent_template_bindings_create:     { resourceType: "project", action: "update", status: "enforced" },
  project_agent_template_bindings_delete:     { resourceType: "project", action: "update", status: "enforced" },
  project_agent_template_bindings_list:       { resourceType: "project", action: "read",   status: "enforced" },
  project_agent_template_bindings_update:     { resourceType: "project", action: "update", status: "enforced" },
  projects_archive:                           { resourceType: "project", action: "update", status: "enforced" },
  projects_create:                            { resourceType: "project", action: "create", status: "enforced" },
  projects_get:                               { resourceType: "project", action: "read",   status: "enforced" },
  projects_list:                              { resourceType: "project", action: "list",   status: "enforced" },
  projects_unarchive:                         { resourceType: "project", action: "update", status: "enforced" },
  projects_update:                            { resourceType: "project", action: "update", status: "enforced" },

  // ───── release_workflow (workflow / workflow_draft / workflow_template) ─────
  workflow_cascade_preview:    { resourceType: "workflow_draft",    action: "read",    status: "enforced" },
  workflow_copy:               { resourceType: "workflow",          action: "create",  status: "enforced" },
  workflow_draft_create:       { resourceType: "workflow_draft",    action: "write",   status: "enforced" },
  workflow_draft_get:          { resourceType: "workflow_draft",    action: "read",    status: "enforced" },
  workflow_draft_list:         { resourceType: "workflow_draft",    action: "read",    status: "enforced" },
  workflow_draft_update:       { resourceType: "workflow_draft",    action: "update",  status: "enforced" },
  workflow_preview:            { resourceType: "workflow_draft",    action: "read",    status: "enforced" },
  workflow_save_as_template:   { resourceType: "workflow_template", action: "create",  status: "enforced" },
  workflow_status_get:         { resourceType: "workflow",          action: "read",    status: "enforced" },
  workflow_status_list:        { resourceType: "workflow",          action: "list",    status: "enforced" },
  workflow_artifacts_list:     { resourceType: "workflow",          action: "read",    status: "enforced" },
  workflow_template_instantiate: { resourceType: "workflow",        action: "create",  status: "enforced" },
  workflow_template_list:      { resourceType: "workflow_template", action: "list",    status: "enforced" },
  workflow_template_get:       { resourceType: "workflow_template", action: "read",    status: "enforced" },
  workflow_validate:           { resourceType: "workflow_draft",    action: "read",    status: "enforced" },

  // ───── skill ─────
  skills_catalog_list:                        { resourceType: "skill", action: "list",    status: "enforced" },
  skills_installed_get:                       { resourceType: "skill", action: "read",    status: "enforced" },
  skills_installed_list:                      { resourceType: "skill", action: "list",    status: "enforced" },
  skills_installed_resolve_for_agent:         { resourceType: "skill", action: "read",    status: "enforced" },
  skills_installed_upsert:                    { resourceType: "skill", action: "update",  status: "enforced" },
  skills_library_list:                        { resourceType: "skill", action: "list",    status: "enforced" },
  skills_match_batch_run_now:                 { resourceType: "skill", action: "execute", status: "enforced" },
  skills_match_evaluate_pair:                 { resourceType: "skill", action: "execute", status: "enforced" },
  skills_match_schedule_get:                  { resourceType: "skill", action: "read",    status: "enforced" },
  skills_match_schedule_set:                  { resourceType: "skill", action: "update",  status: "enforced" },
  skills_matches_refresh:                     { resourceType: "skill", action: "execute", status: "enforced" },
  skills_packages_install_from_github:        { resourceType: "skill", action: "install", status: "enforced" },
  skills_packages_list:                       { resourceType: "skill", action: "list",    status: "enforced" },
  skills_packages_uninstall:                  { resourceType: "skill", action: "uninstall", status: "enforced" },
  skills_personal_delete:                     { resourceType: "skill", action: "delete",  status: "enforced" },
  skills_personal_get:                        { resourceType: "skill", action: "read",    status: "enforced" },
  skills_personal_list:                       { resourceType: "skill", action: "list",    status: "enforced" },
  skills_personal_list_for_agent:             { resourceType: "skill", action: "list",    status: "enforced" },
  skills_personal_skill_create_or_update:     { resourceType: "skill", action: "update",  status: "enforced" },
  skills_personal_upsert:                     { resourceType: "skill", action: "update",  status: "enforced" },

  // ───── social_media ─────
  social_media_publish: { resourceType: "connector_instance", action: "execute", status: "enforced" },

  // ───── trigger ─────
  trigger_config_delete: { resourceType: "trigger", action: "delete", status: "enforced" },
  trigger_config_get:    { resourceType: "trigger", action: "read",   status: "enforced" },
  trigger_config_set:    { resourceType: "trigger", action: "create", status: "enforced" },

  // ───── twenty (connector_instance) ─────
  twenty_instances_list: { resourceType: "connector_instance", action: "list", status: "enforced" },
  twenty_status:         { resourceType: "connector_instance", action: "read", status: "enforced" },

  // ───── wordpress (connector_instance) ─────
  wordpress_content_editor_run:    { resourceType: "connector_instance", action: "execute", status: "enforced" },
  wordpress_instances_list:        { resourceType: "connector_instance", action: "list",    status: "enforced" },
  wordpress_media_upload:          { resourceType: "connector_instance", action: "execute", status: "enforced" },
  wordpress_post_create_draft:     { resourceType: "connector_instance", action: "execute", status: "enforced" },
  wordpress_post_delete:           { resourceType: "connector_instance", action: "execute", status: "enforced" },
  wordpress_post_get:              { resourceType: "connector_instance", action: "execute", status: "enforced" },
  wordpress_post_get_latest:       { resourceType: "connector_instance", action: "execute", status: "enforced" },
  wordpress_post_status:           { resourceType: "connector_instance", action: "read",    status: "enforced" },
  wordpress_post_update:           { resourceType: "connector_instance", action: "execute", status: "enforced" },
  wordpress_post_update_meta:      { resourceType: "connector_instance", action: "execute", status: "enforced" },
  wordpress_posts_list:            { resourceType: "connector_instance", action: "list",    status: "enforced" },
  wordpress_status:                { resourceType: "connector_instance", action: "read",    status: "enforced" },
};

export function lookupPrimitiveClassification(name: string): PrimitiveClassification | undefined {
  return PRIMITIVE_CLASSIFICATIONS[name];
}
