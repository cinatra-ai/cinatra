# Entry 73 — where do the in-core blog renderers render TODAY? (live proof)

**Question (owner):** for the in-core blog renderers in
`src/lib/blog/integration/renderers.tsx` (`BlogPost*` / `BlogPostIdea*` /
`SavedMedia*` — ListRow/Card/Detail), *"which library and review screen? Give
me visual proof."*

**Short answer (ground truth):**

- **Review screen = `/artifacts?mode=types` (Types & approvals, admin).** This is
  the **only** surface in the whole app that reads the in-core blog renderers,
  and it reads them **only as presence indicators** — two small icons per type
  (a `FileText` = has a `detail` renderer, a `Rows` = has a `listRow` renderer),
  lit when the slot is registered, dimmed (`opacity-40`) when it is `null`. It
  **never mounts** the actual `BlogPostCard` / `BlogPostListRow` /
  `BlogPostDetail` components, and it does not even look at the `card` slot.
- **Library = `/artifacts` (Library mode, default).** The in-core blog renderers
  are **not wired to it at all.** The Library lists only the generic
  `SEMANTIC_ARTIFACT_OBJECT_TYPE` object and resolves each row's glyph through a
  **separate** registry (the semantic/artifact-UI dispatch spine, extension
  build-map renderers) — never `objectTypeRegistry.renderers`. Blog objects are
  a different object type, so they can never appear here.
- **As actual cards, the in-core blog renderers render NOWHERE today.** They are
  registered on `objectTypeRegistry` but no live surface mounts them.

This is the honest finding the owner asked for — it is *not* "they render fine in
the library." They don't render as cards anywhere; only their *presence* is
surfaced (as icons) on the Types & approvals admin screen.

---

## Screenshots (each names its exact live route)

All captured on a live authenticated app (admin user `entry73-proof-lane`,
Playwright, viewport 1440×1000, default/light theme) booted from cinatra commit
`da4d7cd0` (the three proof-relevant source files —
`renderers.tsx`, `register-object-types.ts`, `types-approvals-mode.tsx`,
`library-mode.tsx`, `artifact-service.ts`, `register-all-object-types.ts` — are
byte-identical at `da4d7cd0`, at the running checkout `a80f0ff5`, and at
`origin/main` `b451c377`, so this proof holds for current main).

| File | Exact route | What it proves |
|---|---|---|
| `entry73-02-types-approvals-blog-rows.png` | **`/artifacts?mode=types`** | **KEY.** The Static-types list. `@cinatra-ai/assets:blog-idea` (category `idea`) and `@cinatra-ai/assets:blog-post` (category `content`) each show BOTH renderer-presence icons **lit** (a `detail` + a `listRow` renderer is registered). `@cinatra-ai/assets:blog-project` (category `project`) shows BOTH icons **dimmed** — its renderers are `null`. The cards themselves are never drawn here; only these two icons per type are. |
| `entry73-01-types-approvals-full.png` | **`/artifacts?mode=types`** | Full page for context — the entire Static-types register, plus the empty "Proposed types" and "Dynamic types & approval feed" sections. |
| `entry73-03-library-no-blog-cards.png` | **`/artifacts`** (Library) | The Library the owner means. It shows **"No artifacts yet"** — no blog cards. Structural, not incidental: `listArtifacts` filters strictly on `SEMANTIC_ARTIFACT_OBJECT_TYPE`, so `@cinatra-ai/assets:blog-*` objects can never appear here regardless of org/visibility, and the in-core blog renderers are never consulted on this surface. |
| `entry73-04-raw-objects-blog-rows.png` | **`/artifacts?mode=raw&q=blog`** (admin) | The 3 seeded blog objects DO exist in the object substrate — and they render as **plain type-string table rows** (`Object type · Owner/visibility · Source · Ver · Updated`), NOT as `BlogPost*` cards. Corroborates that the in-core renderers paint nothing even where the objects are listed. |

---

## Verified live (DOM, not just eyeballed)

Read directly off the rendered `/artifacts?mode=types` DOM — matches the code exactly:

| Object type | `detail` icon (`FileText`) | `listRow` icon (`Rows`) | Wiring in `register-object-types.ts` |
|---|---|---|---|
| `@cinatra-ai/assets:blog-project` | dimmed (`opacity-40`) | dimmed (`opacity-40`) | `renderers: { listRow: null, card: null, detail: null }` |
| `@cinatra-ai/assets:blog-idea` | lit (`text-foreground`) | lit (`text-foreground`) | `BlogPostIdeaListRow / …Card / …Detail` |
| `@cinatra-ai/assets:blog-post` | lit (`text-foreground`) | lit (`text-foreground`) | `BlogPostListRow / BlogPostCard / BlogPostDetail` |

The sole consumer of `objectTypeRegistry.renderers` app-wide is
`src/components/artifacts/types-approvals-mode.tsx` (lines 109 & 116) — and it
uses them only for this lit/dimmed styling.

---

## Additional ground-truth findings (the owner should see these)

1. **The renderers.tsx header comment is stale.** It describes wiring the three
   `@cinatra-ai/asset-blog:*` types (blog-post, blog-post-idea, saved-media).
   Reality (`register-object-types.ts`): those obsolete types were **removed**;
   the live types are `@cinatra-ai/assets:blog-project|idea|post`.

2. **`SavedMedia*` (the blog-image renderers) are dead code.** There is no
   `saved-media` type registered, and `SavedMediaListRow/Card/Detail` are
   **imported nowhere** — so the "blog image card" the question mentions has no
   renderer wired to any type at all. (Blog image bytes live in the external
   `@cinatra-ai/blog-image-artifact` extension, not in-core.)

3. **`blog-project` has null renderers** — registered only for classification;
   no `listRow`/`card`/`detail`.

4. **There is no in-core blog *pipeline* / draft-review UI.** The
   `draft-editor` / `ideas-panel` / `image-panel` surfaces referenced in the
   renderers.tsx comments **do not exist in-core** — `renderers.tsx` is the only
   `.tsx` file under `src/lib/blog/`. The blog authoring/review UI is shipped by
   **external extensions** (`@cinatra-ai/blog-idea-artifact`,
   `@cinatra-ai/blog-image-artifact`, `@cinatra-ai/blog-post-artifact`,
   `@cinatra-ai/blog-content-workflow`). These appear as SEPARATE
   `…-artifact:artifact` rows in the same Types list (visible in
   `entry73-01-…full.png`) and are out of scope for the in-core-renderer
   question.

5. **The `card` slot is surfaced nowhere** — not even as a presence icon. Only
   `detail` and `listRow` are indicated on the Types screen. So `BlogPostCard` /
   `BlogPostIdeaCard` have zero reachable render path today.

---

## Environment & honest workarounds (so this is reproducible and nothing is hidden)

- **Stack:** local verify stack — Postgres `127.0.0.1:5634` (db `entry73_proof`,
  schema `cinatra`), Redis `127.0.0.1:6579`, dev server on `:3073`, queue
  `entry73_proof`. Auth-origin env pointed at `:3073`.
- **#1751 (core__0053 `LOCK TABLE` boot breaker):** did NOT bite here — the
  `entry73_proof` DB was already migrated through `core__0053` (org.name is
  `NOT NULL`; the fix lives on `origin/lane/fix-core0053`, not yet on main). No
  migration was patched on main.
- **JWKS reset:** the first boot 500'd with Better Auth *"Failed to decrypt
  private key"* — the DB's stored JWKS was encrypted with a different
  `BETTER_AUTH_SECRET` (from a prior lane). Fixed per Better Auth's own guidance
  by clearing `public.jwks` (regenerated on demand). Verify-DB only.
- **Registry warm:** `/artifacts?mode=types` shows *"No static types
  registered"* on a cold server until `objectTypeRegistry` is warmed
  (`registerAllObjectTypes()` runs on the artifact-service / MCP path, not on the
  Types page render). Visiting Library once (`listArtifacts`) warms it, then the
  blog types appear. Minor cold-start note, tangential to the question.
- **Raw-objects visibility:** the seed left all its objects (incl. the 3 blog
  objects, `source=seed-v62-blog`) with `org_id = NULL`. To surface them in the
  org-scoped Raw view I assigned the 3 blog objects `org_id`/`owner_id` = the
  proof org. This only makes existing objects visible in an org; it does not
  change how they render (still plain rows).
