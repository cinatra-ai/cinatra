# Instance Namespace — Freeze Rule and Policy Hooks

> Co-located with the validator module so future maintainers see this when grep'ing for `validateInstanceNamespace`. The validator IS the policy hook; this doc records the constraints around it.

## The Single-Export Rule

`validateInstanceNamespace` is the only place in the codebase that owns:

1. The format regex `^[a-z0-9][a-z0-9\-]{1,38}$` (lowercase alphanumeric + hyphens, must start with alphanumeric, 2–39 chars). The hyphen is escaped so the very same source string also compiles as an HTML `pattern` attribute, which a browser reads with the `v` flag — the escape changes the spelling, never the set of names the rule admits (cinatra#3207). The string form carries a doubled backslash, the regex-literal form a single one; they are the same pattern.
2. The reserved-substring policy (currently `["cinatra"]`, see `reserved-patterns.ts`)
3. The canonicalization rule (`trim → lowercase`)
4. The error-ordering contract (`required → format → reserved → uniqueness/provisioning [reserved slot]`)

All consumers MUST import from `@/lib/instance-namespace` (the barrel). The single-export-site assertion test (`__tests__/single-export-site.test.ts`) enforces this — a parallel regex or an inline copy of the rules will fail CI.

## Current Consumers

| Consumer | Role |
|----------|------|
| `src/app/setup/name/instance-namespace-input.tsx` | Wizard client island — live validation as the user types |
| `src/app/setup/name/actions.ts` (`saveInstanceIdentityAction`) | Server-side gate during initial setup |
| `src/app/configuration/instance/rename-confirmation.tsx` (`RenameConfirmation`) | Administration rename modal — live validation in the post-freeze rename dialog |
| `src/app/configuration/instance/actions.ts` (`editVendorAction`) | Server-side gate for pre-publish credential edits AND post-freeze display-name-only edits (explicitly refuses a namespace change once frozen, rather than silently dropping it) |
| `src/app/configuration/instance/actions.ts` (`renameInstanceNamespaceAction`) | Server-side gate for post-freeze renames |

## The Freeze Rule

Once an instance has published its first extension under its current namespace, `firstPublishedAt` is set to a non-null timestamp and the namespace is **frozen**:

- `editVendorAction` still saves a display-name-only edit when `firstPublishedAt !== null` — the namespace field is read-only in the UI, so in normal use the submitted namespace already equals the current one. Only when the submitted canonical namespace actually DIFFERS from the current one does it redirect with `frozen-namespace-use-rename` ("This instance's namespace is fixed since its first published extension. Use \"Rename vendor\" to change it — editing the display name here is still allowed.") instead of silently dropping the namespace change.
- `renameInstanceNamespaceAction` is the only path forward for an actual namespace change once frozen, and it appends the previous identity to `oldInstanceNamespaces[]`.

The validator does NOT know about the freeze rule — that lives in the actions. **Both freeze-state guards still call the validator first**, so a frozen namespace cannot be renamed *to* a reserved value either.

## Current Non-Goals

The current policy intentionally excludes:

- **No new rename UI.** `RenameConfirmation` is the existing rename UI, mounted on `/configuration/environment`'s frozen-instance card (cinatra#2387); the validator must remain wired into that flow. If a new rename surface is added, it MUST call `validateInstanceNamespace`.
- **No fetch-at-startup for the reserved list.** `reserved-patterns.ts` is the canonical source, consumed directly by the validator; there is no runtime fetch. To change the list, edit that file (see "Updating the Reserved List" below).
- **No display-name validation.** This handles namespace only. `instanceDisplayName` keeps its existing Zod schema in `saveInstanceIdentityAction`.
- **No registry uniqueness check during typing.** Registry provisioning happens at submit; uniqueness is enforced by Verdaccio's `createNpmUser` returning `VerdaccioUserAlreadyRegisteredError`.

## Adding a New Consumer

If a new endpoint accepts or persists `instanceNamespace`:

1. Import `validateInstanceNamespace` from `@/lib/instance-namespace` (the barrel — never sub-paths).
2. Call it on `String(formData.get("instanceNamespace") ?? "")` (or wherever the raw input arrives).
3. On `!result.ok`, compose the verbatim error string from the structured payload and route through your action's existing error-redirect path. Reuse the `composeNamespaceErrorMessage` helper if the new endpoint redirects to a server-rendered error surface; render the structured payload directly if it's a JSON API.
4. Persist `result.canonical`, never the raw form value.
5. Add the new consumer file path to `__tests__/single-export-site.test.ts`'s `CONSUMER_FILES` array so the assertion covers it.

## Updating the Reserved List

If the reserved-patterns list gains a new entry:

1. Edit `reserved-patterns.ts` to mirror the change.
2. Add a test case in `__tests__/validator.test.ts` for the new substring.
3. The verbatim error message in `composeNamespaceErrorMessage` interpolates the matched substring — no copy change needed for the error string itself, but verify the rendered text reads correctly with the new word in the slot.

## Verbatim Error Copy (locked)

Reserved-substring (server + client both render this with `<canonical>` and `<reservedSubstring>` filled from validator output):

> Instance namespace "<canonical>" contains the reserved substring "<reservedSubstring>" and is restricted. Names containing "<reservedSubstring>" are reserved for Cinatra.ai-affiliated instances and require pre-registration. To request approval, open a GitHub issue at Cinatra-ai/cinatra.

The trailing phrase is a clickable link in the client island only. The server-redirect path renders it as plain text inside an `Alert` banner.

Format error (server + client variants share this copy):

> Instance namespace must be 2–39 lowercase letters, digits, or hyphens, starting with a letter or digit.

Required error (server-side):

> Instance namespace is required.
