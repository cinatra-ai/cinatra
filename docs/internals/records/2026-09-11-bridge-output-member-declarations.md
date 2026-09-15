# Bridge-output item-member declarations on the pinned extension set

Measured 2026-09-11 against the pinned extension set of this tree
(`node scripts/ci/sync-dev-extensions.mjs --pinned`), for cinatra#2959.

The measurement runs the runtime's OWN derivation — the
`_derive_bridge_output_schemas` pass and its helpers in
`docker/wayflow/agent_loader.py` — over every
`extensions/*/*/cinatra/oas.json` in the tree, and classifies each bridge
output property by what that pass reports:

- **declared** — every object level the output reaches carries declared members
  (or the output declares no object level at all, e.g. a scalar or an array of
  scalars); the pass reports no free-form path for it.
- **free-form** — the pass reports at least one level with no declared members
  (`items: {"type": "object"}`, or a bare object without `properties`); the
  request is sent closed and empty there, so an answer carries nothing inside.
- **intentionally free-form** — free-form by the rule above, and the output's
  own OAS `description` records that it is meant to stay so.

Only ApiNodes addressing `/api/llm-bridge` are bridge nodes; the pass's own
`_targets_llm_bridge` decides that, so nodes on other host routes
(`/api/context-resolve`, `/api/context-finalize`) are out of scope by
construction.

## Measurement

| package | node / output | classification | evidence | detail |
| --- | --- | --- | --- | --- |
| cinatra-ai/apollo-prospecting-agent | prospect / accountIds | declared | `extensions/cinatra-ai/apollo-prospecting-agent/cinatra/oas.json:216` | declared type: {"items": {"type": "string"}} |
| cinatra-ai/apollo-prospecting-agent | prospect / contactIds | declared | `extensions/cinatra-ai/apollo-prospecting-agent/cinatra/oas.json:221` | declared type: {"items": {"type": "string"}} |
| cinatra-ai/apollo-prospecting-agent | prospect / apolloHitCount | declared | `extensions/cinatra-ai/apollo-prospecting-agent/cinatra/oas.json:225` | declared type: "integer" |
| cinatra-ai/apollo-prospecting-agent | prospect / addedToList | declared | `extensions/cinatra-ai/apollo-prospecting-agent/cinatra/oas.json:226` | declared type: "integer" |
| cinatra-ai/apollo-prospecting-agent | prospect / failures | free-form | `extensions/cinatra-ai/apollo-prospecting-agent/cinatra/oas.json:228` | undeclared level(s): failures[] |
| cinatra-ai/author-agent | author / draft | declared | `extensions/cinatra-ai/author-agent/cinatra/oas.json:192` | declared type: "string" |
| cinatra-ai/blog-draft-writer-agent | write / title | declared | `extensions/cinatra-ai/blog-draft-writer-agent/cinatra/oas.json:575` | declared type: "string" |
| cinatra-ai/blog-draft-writer-agent | write / excerpt | declared | `extensions/cinatra-ai/blog-draft-writer-agent/cinatra/oas.json:580` | declared type: "string" |
| cinatra-ai/blog-draft-writer-agent | write / content | declared | `extensions/cinatra-ai/blog-draft-writer-agent/cinatra/oas.json:585` | declared type: "string" |
| cinatra-ai/blog-draft-writer-agent | write / sourcesUsed | declared | `extensions/cinatra-ai/blog-draft-writer-agent/cinatra/oas.json:590` | declared type: {"items": {"type": "string"}} |
| cinatra-ai/blog-draft-writer-agent | write / notes | declared | `extensions/cinatra-ai/blog-draft-writer-agent/cinatra/oas.json:600` | declared type: "string" |
| cinatra-ai/blog-idea-generator-agent | generate / ideas | declared | `extensions/cinatra-ai/blog-idea-generator-agent/cinatra/oas.json:491` | declared type: {"items": {"type": "string"}} |
| cinatra-ai/blog-idea-generator-agent | generate / notes | declared | `extensions/cinatra-ai/blog-idea-generator-agent/cinatra/oas.json:500` | declared type: "string" |
| cinatra-ai/blog-image-generator-agent | generate / image | declared | `extensions/cinatra-ai/blog-image-generator-agent/cinatra/oas.json:411` | declared type: {"properties": {"altText": {"type": "string"}, "placement": {"enum": ["featured"], "type": "string"}, "post": {"type": "string"}, "prompt": {"type": "string"}}, "required": ["placement", "post", "prompt", "altText"], "type": "object"} |
| cinatra-ai/blog-image-generator-agent | generate / notes | declared | `extensions/cinatra-ai/blog-image-generator-agent/cinatra/oas.json:441` | declared type: "string" |
| cinatra-ai/blog-image-prompt-agent | generate / prompts | free-form | `extensions/cinatra-ai/blog-image-prompt-agent/cinatra/oas.json:481` | undeclared level(s): prompts[] |
| cinatra-ai/blog-image-prompt-agent | generate / notes | declared | `extensions/cinatra-ai/blog-image-prompt-agent/cinatra/oas.json:490` | declared type: "string" |
| cinatra-ai/blog-linkedin-publish-agent | publish / projectId | declared | `extensions/cinatra-ai/blog-linkedin-publish-agent/cinatra/oas.json:316` | declared type: "string" |
| cinatra-ai/blog-linkedin-publish-agent | publish / postId | declared | `extensions/cinatra-ai/blog-linkedin-publish-agent/cinatra/oas.json:320` | declared type: "string" |
| cinatra-ai/blog-linkedin-publish-agent | publish / linkedinDraftId | declared | `extensions/cinatra-ai/blog-linkedin-publish-agent/cinatra/oas.json:415` | declared type: "string" |
| cinatra-ai/blog-linkedin-publish-agent | publish / linkedinPostUrl | declared | `extensions/cinatra-ai/blog-linkedin-publish-agent/cinatra/oas.json:419` | declared type: "string" |
| cinatra-ai/blog-linkedin-publish-agent | publish / approved | declared | `extensions/cinatra-ai/blog-linkedin-publish-agent/cinatra/oas.json:423` | declared type: "boolean" |
| cinatra-ai/blog-linkedin-publish-agent | publish / summary | declared | `extensions/cinatra-ai/blog-linkedin-publish-agent/cinatra/oas.json:427` | declared type: "string" |
| cinatra-ai/blog-linkedin-writer-agent | write / post | declared | `extensions/cinatra-ai/blog-linkedin-writer-agent/cinatra/oas.json:363` | declared type: "string" |
| cinatra-ai/blog-linkedin-writer-agent | write / title | declared | `extensions/cinatra-ai/blog-linkedin-writer-agent/cinatra/oas.json:367` | declared type: "string" |
| cinatra-ai/blog-linkedin-writer-agent | write / notes | declared | `extensions/cinatra-ai/blog-linkedin-writer-agent/cinatra/oas.json:371` | declared type: "string" |
| cinatra-ai/blog-pipeline-agent | blog-idea-generator-agent__generate / ideas | free-form | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:1273` | undeclared level(s): ideas[] |
| cinatra-ai/blog-pipeline-agent | blog-idea-generator-agent__generate / notes | declared | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:1282` | declared type: "string" |
| cinatra-ai/blog-pipeline-agent | blog-draft-writer-agent__write / draft | free-form | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:2572` | undeclared level(s): draft |
| cinatra-ai/blog-pipeline-agent | blog-draft-writer-agent__write / notes | declared | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:2576` | declared type: "string" |
| cinatra-ai/blog-pipeline-agent | blog-image-prompt-agent__generate / prompts | free-form | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:3835` | undeclared level(s): prompts[] |
| cinatra-ai/blog-pipeline-agent | blog-image-prompt-agent__generate / notes | declared | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:3844` | declared type: "string" |
| cinatra-ai/blog-pipeline-agent | blog-linkedin-writer-agent__write / post | declared | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:5010` | declared type: "string" |
| cinatra-ai/blog-pipeline-agent | blog-linkedin-writer-agent__write / title | declared | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:5014` | declared type: "string" |
| cinatra-ai/blog-pipeline-agent | blog-linkedin-writer-agent__write / notes | declared | `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:5018` | declared type: "string" |
| cinatra-ai/blog-wordpress-publish-agent | publish / projectId | declared | `extensions/cinatra-ai/blog-wordpress-publish-agent/cinatra/oas.json:223` | declared type: "string" |
| cinatra-ai/blog-wordpress-publish-agent | publish / postId | declared | `extensions/cinatra-ai/blog-wordpress-publish-agent/cinatra/oas.json:227` | declared type: "string" |
| cinatra-ai/blog-wordpress-publish-agent | publish / wordpressDraftId | declared | `extensions/cinatra-ai/blog-wordpress-publish-agent/cinatra/oas.json:275` | declared type: "string" |
| cinatra-ai/blog-wordpress-publish-agent | publish / wordpressAdminUrl | declared | `extensions/cinatra-ai/blog-wordpress-publish-agent/cinatra/oas.json:279` | declared type: "string" |
| cinatra-ai/blog-wordpress-publish-agent | publish / approved | declared | `extensions/cinatra-ai/blog-wordpress-publish-agent/cinatra/oas.json:283` | declared type: "boolean" |
| cinatra-ai/blog-wordpress-publish-agent | publish / summary | declared | `extensions/cinatra-ai/blog-wordpress-publish-agent/cinatra/oas.json:287` | declared type: "string" |
| cinatra-ai/code-reviewer-agent | review / findings | declared | `extensions/cinatra-ai/code-reviewer-agent/cinatra/oas.json:216` | declared type: "string" |
| cinatra-ai/company-discovery-agent | discover / accountId | declared | `extensions/cinatra-ai/company-discovery-agent/cinatra/oas.json:252` | declared type: "string" |
| cinatra-ai/company-discovery-agent | discover / wasMerged | declared | `extensions/cinatra-ai/company-discovery-agent/cinatra/oas.json:256` | declared type: "boolean" |
| cinatra-ai/company-discovery-agent | discover / apolloOrganizationId | declared | `extensions/cinatra-ai/company-discovery-agent/cinatra/oas.json:260` | declared type: "string" |
| cinatra-ai/contact-discovery-agent | discover / contactIds | declared | `extensions/cinatra-ai/contact-discovery-agent/cinatra/oas.json:191` | declared type: {"items": {"type": "string"}} |
| cinatra-ai/contact-discovery-agent | discover / apolloHitCount | declared | `extensions/cinatra-ai/contact-discovery-agent/cinatra/oas.json:195` | declared type: "integer" |
| cinatra-ai/contact-discovery-agent | discover / webFallbackUsed | declared | `extensions/cinatra-ai/contact-discovery-agent/cinatra/oas.json:196` | declared type: "boolean" |
| cinatra-ai/contact-discovery-agent | discover / failures | free-form | `extensions/cinatra-ai/contact-discovery-agent/cinatra/oas.json:198` | undeclared level(s): failures[] |
| cinatra-ai/drupal-agent | load_node / nodeId | declared | `extensions/cinatra-ai/drupal-agent/cinatra/oas.json:242` | declared type: "string" |
| cinatra-ai/drupal-agent | load_node / changes | free-form | `extensions/cinatra-ai/drupal-agent/cinatra/oas.json:312` | undeclared level(s): changes[] |
| cinatra-ai/email-delivery-agent | prepare / summary | free-form | `extensions/cinatra-ai/email-delivery-agent/cinatra/oas.json:384` | undeclared level(s): summary |
| cinatra-ai/email-delivery-agent | send / sendResult | free-form | `extensions/cinatra-ai/email-delivery-agent/cinatra/oas.json:473` | undeclared level(s): sendResult |
| cinatra-ai/email-drafting-agent | draft / draftBundle | free-form | `extensions/cinatra-ai/email-drafting-agent/cinatra/oas.json:304` | undeclared level(s): draftBundle, draftBundle[] |
| cinatra-ai/email-drafting-agent | draft / draftBundleTitle | declared | `extensions/cinatra-ai/email-drafting-agent/cinatra/oas.json:313` | declared type: "string" |
| cinatra-ai/email-drafting-agent | draft / draftBundleDocument | declared | `extensions/cinatra-ai/email-drafting-agent/cinatra/oas.json:317` | declared type: "string" |
| cinatra-ai/email-follow-up-agent | followup / followupBundle | free-form | `extensions/cinatra-ai/email-follow-up-agent/cinatra/oas.json:226` | undeclared level(s): followupBundle |
| cinatra-ai/email-follow-up-agent | followup / followupDigest | declared | `extensions/cinatra-ai/email-follow-up-agent/cinatra/oas.json:230` | declared type: "string" |
| cinatra-ai/email-follow-up-agent | followup / summary | declared | `extensions/cinatra-ai/email-follow-up-agent/cinatra/oas.json:234` | declared type: "string" |
| cinatra-ai/email-outreach-agent | recipients-generate / confirmedRecipientsRef | declared | `extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json:759` | declared type: {"format": "uuid"} |
| cinatra-ai/email-outreach-agent | recipients-generate / recipientCount | declared | `extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json:766` | declared type: "integer" |
| cinatra-ai/email-outreach-agent | recipients-generate / confirmedRecipients | free-form | `extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json:770` | undeclared level(s): confirmedRecipients[] |
| cinatra-ai/email-outreach-agent | drafts-draft / draftBundleRef | declared | `extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json:1235` | declared type: {"format": "uuid"} |
| cinatra-ai/email-outreach-agent | sender-send / sendResult | free-form | `extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json:1644` | undeclared level(s): sendResult |
| cinatra-ai/email-recipient-selection-agent | generate / campaignId | declared | `extensions/cinatra-ai/email-recipient-selection-agent/cinatra/oas.json:296` | declared type: {"format": "uuid"} |
| cinatra-ai/email-recipient-selection-agent | generate / recipientCount | declared | `extensions/cinatra-ai/email-recipient-selection-agent/cinatra/oas.json:340` | declared type: "integer" |
| cinatra-ai/email-recipient-selection-agent | generate / confirmedRecipients | free-form | `extensions/cinatra-ai/email-recipient-selection-agent/cinatra/oas.json:344` | undeclared level(s): confirmedRecipients[] |
| cinatra-ai/list-curator-agent | curate / listId | declared | `extensions/cinatra-ai/list-curator-agent/cinatra/oas.json:369` | declared type: "string" |
| cinatra-ai/list-curator-agent | curate / memberCount | declared | `extensions/cinatra-ai/list-curator-agent/cinatra/oas.json:373` | declared type: "integer" |
| cinatra-ai/list-curator-agent | curate / accountsCreated | declared | `extensions/cinatra-ai/list-curator-agent/cinatra/oas.json:377` | declared type: "integer" |
| cinatra-ai/list-curator-agent | curate / contactsCreated | declared | `extensions/cinatra-ai/list-curator-agent/cinatra/oas.json:381` | declared type: "integer" |
| cinatra-ai/list-curator-agent | curate / failures | free-form | `extensions/cinatra-ai/list-curator-agent/cinatra/oas.json:385` | undeclared level(s): failures[] |
| cinatra-ai/list-curator-agent | curate / summary | declared | `extensions/cinatra-ai/list-curator-agent/cinatra/oas.json:394` | declared type: "string" |
| cinatra-ai/media-feed-lister-agent | list / sourceTitle | declared | `extensions/cinatra-ai/media-feed-lister-agent/cinatra/oas.json:221` | declared type: "string" |
| cinatra-ai/media-feed-lister-agent | list / sourceUrl | declared | `extensions/cinatra-ai/media-feed-lister-agent/cinatra/oas.json:222` | declared type: "string" |
| cinatra-ai/media-feed-lister-agent | list / detectedType | declared | `extensions/cinatra-ai/media-feed-lister-agent/cinatra/oas.json:223` | declared type: "string" |
| cinatra-ai/media-feed-lister-agent | list / episodes | free-form | `extensions/cinatra-ai/media-feed-lister-agent/cinatra/oas.json:225` | undeclared level(s): episodes[] |
| cinatra-ai/media-feed-lister-agent | list / failureCode | declared | `extensions/cinatra-ai/media-feed-lister-agent/cinatra/oas.json:229` | declared type: "string" |
| cinatra-ai/media-transcript-agent | call_bridge / text | declared | `extensions/cinatra-ai/media-transcript-agent/cinatra/oas.json:254` | declared type: "string" |
| cinatra-ai/planner-agent | review / findings | declared | `extensions/cinatra-ai/planner-agent/cinatra/oas.json:216` | declared type: "string" |
| cinatra-ai/security-reviewer-agent | review / findings | declared | `extensions/cinatra-ai/security-reviewer-agent/cinatra/oas.json:216` | declared type: "string" |
| cinatra-ai/web-research-agent | research / enrichedRows | free-form | `extensions/cinatra-ai/web-research-agent/cinatra/oas.json:219` | undeclared level(s): enrichedRows[] |
| cinatra-ai/web-research-agent | research / extractionNotes | declared | `extensions/cinatra-ai/web-research-agent/cinatra/oas.json:223` | declared type: "string" |
| cinatra-ai/web-research-agent | research / failures | free-form | `extensions/cinatra-ai/web-research-agent/cinatra/oas.json:225` | undeclared level(s): failures[] |
| cinatra-ai/web-research-agent | research / webChecks | free-form | `extensions/cinatra-ai/web-research-agent/cinatra/oas.json:230` | undeclared level(s): webChecks[] |
| cinatra-ai/web-scrape-agent | extract / items | free-form | `extensions/cinatra-ai/web-scrape-agent/cinatra/oas.json:342` | undeclared level(s): items[] |
| cinatra-ai/web-scrape-agent | extract / sourceUrls | declared | `extensions/cinatra-ai/web-scrape-agent/cinatra/oas.json:346` | declared type: {"items": {"type": "string"}} |
| cinatra-ai/web-scrape-agent | extract / extractionNotes | declared | `extensions/cinatra-ai/web-scrape-agent/cinatra/oas.json:355` | declared type: "string" |
| cinatra-ai/web-scrape-agent | extract / failures | free-form | `extensions/cinatra-ai/web-scrape-agent/cinatra/oas.json:359` | undeclared level(s): failures[] |
| cinatra-ai/wordpress-agent | edit / postId | declared | `extensions/cinatra-ai/wordpress-agent/cinatra/oas.json:354` | declared type: "string" |
| cinatra-ai/wordpress-agent | edit / instanceId | declared | `extensions/cinatra-ai/wordpress-agent/cinatra/oas.json:350` | declared type: "string" |
| cinatra-ai/wordpress-agent | edit / proposalId | declared | `extensions/cinatra-ai/wordpress-agent/cinatra/oas.json:428` | declared type: "string" |
| cinatra-ai/wordpress-agent | edit / changeSetId | declared | `extensions/cinatra-ai/wordpress-agent/cinatra/oas.json:432` | declared type: "string" |
| cinatra-ai/wordpress-agent | edit / changes | free-form | `extensions/cinatra-ai/wordpress-agent/cinatra/oas.json:436` | undeclared level(s): changes[] |
| cinatra-ai/wordpress-agent | edit / error | free-form | `extensions/cinatra-ai/wordpress-agent/cinatra/oas.json:445` | undeclared level(s): error |

## Counts

| quantity | value |
| --- | --- |
| `cinatra/oas.json` files scanned | 30 |
| packages carrying at least one bridge node | 27 |
| bridge output properties | 95 |
| declared | 72 |
| intentionally free-form | 0 |
| free-form (neither declared nor recorded) | 23 |

## The runtime's per-node disclosure

The loader module cannot be imported as a module outside the runtime image on a
plain host: its top-level `import uvicorn`, `starlette` and
`context_subflow_injection` are unavailable there, measured as

    python3 -c "import uvicorn"
    ModuleNotFoundError: No module named 'uvicorn'

There is also no test or CLI entry point for the module in the tree. The
disclosure was therefore obtained by executing the loader file's own
derivation span verbatim — from `_LLM_BRIDGE_PATH` through
`_derive_bridge_output_schemas`, sliced out of `docker/wayflow/agent_loader.py`
and compiled as-is, no re-implementation — and calling
`_derive_bridge_output_schemas(doc, package)` on each parsed OAS document. The
classification above is that pass's output, not a static reading of the JSON.

The pass printed 19 disclosure lines, one per bridge node that still reaches an
undeclared level:

- [agent_loader] NOTE: cinatra-ai/apollo-prospecting-agent: bridge ApiNode 'prospect' declares no members for failures[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/blog-image-prompt-agent: bridge ApiNode 'generate' declares no members for prompts[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/blog-pipeline-agent: bridge ApiNode 'blog-idea-generator-agent__generate' declares no members for ideas[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/blog-pipeline-agent: bridge ApiNode 'blog-draft-writer-agent__write' declares no members for draft; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/blog-pipeline-agent: bridge ApiNode 'blog-image-prompt-agent__generate' declares no members for prompts[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/contact-discovery-agent: bridge ApiNode 'discover' declares no members for failures[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/drupal-agent: bridge ApiNode 'load_node' declares no members for changes[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/email-delivery-agent: bridge ApiNode 'prepare' declares no members for summary; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/email-delivery-agent: bridge ApiNode 'send' declares no members for sendResult; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/email-drafting-agent: bridge ApiNode 'draft' declares no members for draftBundle, draftBundle[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/email-follow-up-agent: bridge ApiNode 'followup' declares no members for followupBundle; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/email-outreach-agent: bridge ApiNode 'recipients-generate' declares no members for confirmedRecipients[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/email-outreach-agent: bridge ApiNode 'sender-send' declares no members for sendResult; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/email-recipient-selection-agent: bridge ApiNode 'generate' declares no members for confirmedRecipients[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/list-curator-agent: bridge ApiNode 'curate' declares no members for failures[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/media-feed-lister-agent: bridge ApiNode 'list' declares no members for episodes[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/web-research-agent: bridge ApiNode 'research' declares no members for enrichedRows[], failures[], webChecks[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/web-scrape-agent: bridge ApiNode 'extract' declares no members for failures[], items[]; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.
- [agent_loader] NOTE: cinatra-ai/wordpress-agent: bridge ApiNode 'edit' declares no members for changes[], error; the request can promise nothing about them. An object level with no declared members is sent CLOSED and EMPTY (the strict structured-output contract has no open map), so an answer carries nothing there. Declare the members in the agent's own OAS (`json_schema.items` / `json_schema.properties`) to close it properly.

## Criteria

**Criterion 1 — the blog idea generator and the blog pipeline agent declare
their `ideas` item members: FAIL.**

- `cinatra-ai/blog-idea-generator-agent` declares
  `"ideas": {"type": "array", "json_schema": {"items": {"type": "string"}}}`
  (`extensions/cinatra-ai/blog-idea-generator-agent/cinatra/oas.json:491`). The
  item is a fully typed scalar, so the pass reports no free-form level for it;
  the pack's node metadata records how that scalar is read: "The host
  run-completion materializer then files ONE @cinatra-ai/blog-idea-artifact per
  member of ideas through the declarative fan-out EndNode binding, each titled
  from that member's own first line, not a tool call the LLM makes."
  (`extensions/cinatra-ai/blog-idea-generator-agent/cinatra/oas.json:509`). A
  string item carries no `title`/`summary`/`outline` members, so whether this
  reads as the declared equivalent turns on that materializer contract; it is
  not free-form either way.
- `cinatra-ai/blog-pipeline-agent` still carries the OLD shape on its embedded
  copy of the same node: `"ideas": {"type": "array", "json_schema": {"items":
  {"type": "object"}}}`
  (`extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:1273`), and the
  pass discloses `ideas[]` as undeclared for it. The two packs therefore
  disagree about the same output, and the pipeline's `ideas` entries still come
  back empty.

The criterion names both agents, and the pipeline agent does not declare, so
it reads FAIL.

**Criterion 2 — the remaining free-form outputs are either declared or
individually recorded as intentionally free-form in the agent's own OAS
description: FAIL.** 23 of 95 bridge output properties are free-form and none
of the 23 carries a description recording that as intentional (0 in the counts
above). They are listed under remaining gaps.

**Criterion 3 — the per-node disclosure shows no undeclared free-form level for
the agents changed: FAIL.** The disclosure reproduced above still prints 19
lines. The standalone blog agents whose members were declared are clean in it —
`blog-idea-generator-agent`, `blog-draft-writer-agent`,
`blog-linkedin-writer-agent`, `blog-image-generator-agent`,
`blog-linkedin-publish-agent` and `blog-wordpress-publish-agent` print no line
— but `blog-pipeline-agent` prints three (`ideas[]`, `draft`, `prompts[]`) and
`blog-image-prompt-agent` prints one (`prompts[]`), so the blog set named by
criterion 1 is not clean.

## Remaining gaps

Each entry below is a bridge output that is neither declared nor recorded as
intentionally free-form. Every one of them is a declaration in the listed
package's OWN repository — the fix is one `json_schema.items` /
`json_schema.properties` addition there, never a change in this tree.

- `cinatra-ai/apollo-prospecting-agent` — output `prospect / failures` — undeclared level(s): failures[] — `extensions/cinatra-ai/apollo-prospecting-agent/cinatra/oas.json:228`
- `cinatra-ai/blog-image-prompt-agent` — output `generate / prompts` — undeclared level(s): prompts[] — `extensions/cinatra-ai/blog-image-prompt-agent/cinatra/oas.json:481`
- `cinatra-ai/blog-pipeline-agent` — output `blog-idea-generator-agent__generate / ideas` — undeclared level(s): ideas[] — `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:1273`
- `cinatra-ai/blog-pipeline-agent` — output `blog-draft-writer-agent__write / draft` — undeclared level(s): draft — `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:2572`
- `cinatra-ai/blog-pipeline-agent` — output `blog-image-prompt-agent__generate / prompts` — undeclared level(s): prompts[] — `extensions/cinatra-ai/blog-pipeline-agent/cinatra/oas.json:3835`
- `cinatra-ai/contact-discovery-agent` — output `discover / failures` — undeclared level(s): failures[] — `extensions/cinatra-ai/contact-discovery-agent/cinatra/oas.json:198`
- `cinatra-ai/drupal-agent` — output `load_node / changes` — undeclared level(s): changes[] — `extensions/cinatra-ai/drupal-agent/cinatra/oas.json:312`
- `cinatra-ai/email-delivery-agent` — output `prepare / summary` — undeclared level(s): summary — `extensions/cinatra-ai/email-delivery-agent/cinatra/oas.json:384`
- `cinatra-ai/email-delivery-agent` — output `send / sendResult` — undeclared level(s): sendResult — `extensions/cinatra-ai/email-delivery-agent/cinatra/oas.json:473`
- `cinatra-ai/email-drafting-agent` — output `draft / draftBundle` — undeclared level(s): draftBundle, draftBundle[] — `extensions/cinatra-ai/email-drafting-agent/cinatra/oas.json:304`
- `cinatra-ai/email-follow-up-agent` — output `followup / followupBundle` — undeclared level(s): followupBundle — `extensions/cinatra-ai/email-follow-up-agent/cinatra/oas.json:226`
- `cinatra-ai/email-outreach-agent` — output `recipients-generate / confirmedRecipients` — undeclared level(s): confirmedRecipients[] — `extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json:770`
- `cinatra-ai/email-outreach-agent` — output `sender-send / sendResult` — undeclared level(s): sendResult — `extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json:1644`
- `cinatra-ai/email-recipient-selection-agent` — output `generate / confirmedRecipients` — undeclared level(s): confirmedRecipients[] — `extensions/cinatra-ai/email-recipient-selection-agent/cinatra/oas.json:344`
- `cinatra-ai/list-curator-agent` — output `curate / failures` — undeclared level(s): failures[] — `extensions/cinatra-ai/list-curator-agent/cinatra/oas.json:385`
- `cinatra-ai/media-feed-lister-agent` — output `list / episodes` — undeclared level(s): episodes[] — `extensions/cinatra-ai/media-feed-lister-agent/cinatra/oas.json:225`
- `cinatra-ai/web-research-agent` — output `research / enrichedRows` — undeclared level(s): enrichedRows[] — `extensions/cinatra-ai/web-research-agent/cinatra/oas.json:219`
- `cinatra-ai/web-research-agent` — output `research / failures` — undeclared level(s): failures[] — `extensions/cinatra-ai/web-research-agent/cinatra/oas.json:225`
- `cinatra-ai/web-research-agent` — output `research / webChecks` — undeclared level(s): webChecks[] — `extensions/cinatra-ai/web-research-agent/cinatra/oas.json:230`
- `cinatra-ai/web-scrape-agent` — output `extract / items` — undeclared level(s): items[] — `extensions/cinatra-ai/web-scrape-agent/cinatra/oas.json:342`
- `cinatra-ai/web-scrape-agent` — output `extract / failures` — undeclared level(s): failures[] — `extensions/cinatra-ai/web-scrape-agent/cinatra/oas.json:359`
- `cinatra-ai/wordpress-agent` — output `edit / changes` — undeclared level(s): changes[] — `extensions/cinatra-ai/wordpress-agent/cinatra/oas.json:436`
- `cinatra-ai/wordpress-agent` — output `edit / error` — undeclared level(s): error — `extensions/cinatra-ai/wordpress-agent/cinatra/oas.json:445`

## Reproducing the measurement

Run from the repository root after
`node scripts/ci/sync-dev-extensions.mjs --pinned`, with `python3`:

```python
#!/usr/bin/env python3
"""Measure bridge-output item-member declarations across the pinned extension set.

Runs the runtime's OWN derivation (docker/wayflow/agent_loader.py) over every
`extensions/**/cinatra/oas.json` in the tree. The derivation block is read from
the loader file and executed verbatim, so the classification below is the
runtime's, not a re-implementation: the loader module itself cannot be imported
outside the runtime image (its top-level `import uvicorn` / `starlette` /
`context_subflow_injection` are absent elsewhere), so the pure-Python span that
carries `_derive_bridge_output_schemas` and its helpers is sliced out by the
marker lines below and executed as-is.
"""
from __future__ import annotations

import io
import json
import contextlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple  # noqa: F401  (used by the sliced span)

ROOT = Path.cwd()
LOADER = ROOT / "docker" / "wayflow" / "agent_loader.py"

START = '_LLM_BRIDGE_PATH = "/api/llm-bridge"'
END = "#: Matched with"


def load_derivation() -> Dict[str, Any]:
    src = LOADER.read_text(encoding="utf-8")
    start = src.index(START)
    end = src.index(END, start)
    span = src[start:end]
    ns: Dict[str, Any] = {
        "Any": Any, "Dict": Dict, "List": List, "Optional": Optional,
        "json": json, "__name__": "agent_loader_derivation",
    }
    exec(compile(span, str(LOADER), "exec"), ns)  # noqa: S102 - the loader's own source
    return ns


def bridge_nodes(doc: Any, targets) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            if obj.get("component_type") == "ApiNode" and targets(obj.get("url")):
                found.append(obj)
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)

    walk(doc)
    return found


def line_of(path: Path, node_id: str, title: str) -> int:
    """First line where this output's title is declared after the node's id."""
    lines = path.read_text(encoding="utf-8").splitlines()
    anchor = 0
    needle_id = '"%s"' % node_id
    for index, line in enumerate(lines):
        if needle_id in line:
            anchor = index
            break
    needle = '"title": "%s"' % title
    for index in range(anchor, len(lines)):
        if needle in lines[index]:
            return index + 1
    for index, line in enumerate(lines):
        if needle in line:
            return index + 1
    return 0


FREEFORM_WORDS = ("free-form", "free form", "freeform", "arbitrary", "unstructured",
                  "no fixed shape", "opaque")


def intentional(prop: Dict[str, Any]) -> Optional[str]:
    text = prop.get("description")
    if not isinstance(text, str) or not text:
        return None
    low = text.lower()
    if any(word in low for word in FREEFORM_WORDS):
        return text.strip()
    return None


def main() -> int:
    ns = load_derivation()
    derive = ns["_derive_bridge_output_schemas"]
    targets = ns["_targets_llm_bridge"]

    files = sorted(Path("extensions").glob("*/*/cinatra/oas.json"))
    rows: List[Tuple[str, str, str, str, str]] = []
    notes: List[str] = []
    counts = {"declared": 0, "free-form": 0, "intentionally free-form": 0}
    packages_with_bridge = 0

    for path in files:
        package = "/".join(path.parts[1:3])
        doc = json.loads(path.read_text(encoding="utf-8"))
        nodes = bridge_nodes(doc, targets)
        if not nodes:
            continue
        packages_with_bridge += 1
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            report = derive(doc, package)
        for line in buffer.getvalue().splitlines():
            if line.strip():
                notes.append(line.strip())
        by_node = {str(entry["node"]): entry for entry in report}
        for node in nodes:
            node_id = str(node.get("id") or node.get("name"))
            entry = by_node.get(node_id)
            if entry is None:
                continue
            free = set(entry["free_form"])
            for prop in node.get("outputs") or []:
                if not isinstance(prop, dict):
                    continue
                title = prop.get("title")
                if not isinstance(title, str) or not title:
                    continue
                hit = sorted(
                    p for p in free
                    if p == title or p.startswith(title + "[") or p.startswith(title + ".")
                )
                if hit:
                    sentence = intentional(prop)
                    if sentence:
                        kind = "intentionally free-form"
                        evidence = sentence
                    else:
                        kind = "free-form"
                        evidence = "undeclared level(s): " + ", ".join(hit)
                else:
                    kind = "declared"
                    evidence = "declared type: " + json.dumps(
                        prop.get("json_schema", prop.get("items", prop.get("type"))),
                        sort_keys=True,
                    )
                counts[kind] += 1
                rows.append((
                    package, "%s / %s" % (node_id, title), kind,
                    "%s:%d" % (path.as_posix(), line_of(path, node_id, title)),
                    evidence,
                ))

    print("| package | node / output | classification | evidence | detail |")
    print("| --- | --- | --- | --- | --- |")
    for row in rows:
        print("| %s | %s | %s | `%s` | %s |" % row)
    print()
    print("files scanned: %d" % len(files))
    print("packages with a bridge node: %d" % packages_with_bridge)
    print("bridge output properties: %d" % len(rows))
    for key in ("declared", "intentionally free-form", "free-form"):
        print("%s: %d" % (key, counts[key]))
    print()
    print("per-node disclosure lines: %d" % len(notes))
    for note in notes:
        print("  " + note)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

The table, the counts and the disclosure lines above are that program's output
verbatim.
