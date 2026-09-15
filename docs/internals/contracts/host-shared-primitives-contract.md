# Host-shared design primitives — the contract

The record to read before migrating a package in slice 3
(cinatra-ai/cinatra#3471, epic #2926, decision 407 of 2026-09-13: *the host
shares its primitives with extension bundles at run time like React does — the
only way to keep the border between core and self-rendering extensions clean*).

Slice 1 (the self-rendering-extensions border gate) froze today's byte copies in
a shrink-only baseline. Slice 2 — this record — builds the road those copies move
onto. Slice 3 moves the packages, one package at a time.

## The module

| | |
| --- | --- |
| Module id | `@cinatra-ai/design-primitives` |
| Contract version | `1.0.0` (major `1`) |
| Declared in | `packages/sdk-extensions/src/artifact-client-bundle.ts`, next to the React externals allowlist |
| Typed contract export | `@cinatra-ai/sdk-extensions/design-primitives-contract` |
| Host implementation | `src/lib/artifacts/host-shared-primitives.ts` |
| Resolved at run time by | `src/lib/artifacts/host-module-registry.ts` |

The id is host-neutral and follows the design registry's own package naming
(`registry.json` namespaces every item as `@cinatra-ai/<item>`, the same scope
the host design-token module already uses). It is never a product-internal path
such as
`@/components/ui` — that coupling is exactly what decision 407 removes.

## The road (the same one React takes)

1. A package leaves `@cinatra-ai/design-primitives` **external** in its client
   bundle. The externals allowlist (`CLIENT_BUNDLE_EXTERNAL_ALLOWLIST`) admits
   the id, and `checkClientBundleExternals` accepts it with the same exact-tuple
   discipline React has — a near-miss specifier such as
   `@cinatra-ai/design-primitives/button` is still refused.
2. The publish-time bundle road
   (`scripts/extensions/build-client-renderer-bundle.mjs`) externalizes it. That
   script inlines a mirror of the SDK constants for standalone-repo execution;
   the mirror and the SDK source are pinned in lockstep by
   `scripts/extensions/__tests__/build-client-renderer-bundle.test.mjs`.
3. At run time the host module-registry shim resolves the id to the host's ONE
   instance (`initHostModuleRegistry({ ..., designPrimitives })`), the same
   `Symbol.for` singleton React and the design tokens already use. The shim is
   extended, not forked.
5. `assertDesignPrimitivesBundleConformance(loadedModule)` is what the client
   loader seam (`src/app/artifacts/[id]/dynamic-renderer-loader.tsx`) runs on a
   freshly imported renderer, beside the single-React-identity assert. It reads
   the bundle PREAMBLE — the same road `__cinatraReact` already takes, so no
   publish record and no signature change:

   | Preamble field | Checked by |
   | --- | --- |
   | `__cinatraDesignPrimitivesContract` | `assertDesignPrimitivesContractServed` — a bundle built against a contract **major** this host does not serve fails closed with a named error (`Error.name === "DesignPrimitivesContractMajorMismatch"`); a malformed version on either side is refused too, never treated as compatible |
   | `__cinatraDesignPrimitives` | `assertSingleDesignPrimitivesIdentity` — a SECOND copy throws loudly instead of surfacing as mismatched theming and duplicated portals. A façade NAMESPACE re-export of the host module is accepted: identity is judged per export, not on the wrapper |

   A bundle that declares neither field does not use the shared module and passes
   untouched.

## The frozen export list (contract major 1)

Exactly the exports of the sixteen product components under `src/components/ui/`
that the border floor records as byte copies inside connector and artifact
packages. Adding a name is a MINOR bump; removing or renaming one is a MAJOR.

| Component | Exports |
| --- | --- |
| `alert` | `Alert`, `AlertDescription`, `AlertTitle` |
| `badge` | `Badge`, `badgeVariants` |
| `button` | `Button`, `buttonVariants` |
| `card` | `Card`, `CardAction`, `CardContent`, `CardDescription`, `CardFooter`, `CardHeader`, `CardTitle` |
| `checkbox` | `Checkbox` |
| `dialog` | `Dialog`, `DialogClose`, `DialogContent`, `DialogDescription`, `DialogFooter`, `DialogHeader`, `DialogOverlay`, `DialogPortal`, `DialogTitle`, `DialogTrigger` |
| `field` | `Field`, `FieldContent`, `FieldDescription`, `FieldError`, `FieldGroup`, `FieldLabel`, `FieldLegend`, `FieldSeparator`, `FieldSet`, `FieldTitle` |
| `input` | `Input` |
| `input-group` | `InputGroup`, `InputGroupAddon`, `InputGroupButton`, `InputGroupInput`, `InputGroupText`, `InputGroupTextarea` |
| `label` | `Label` |
| `paginated-table` | `PaginatedTable` |
| `pagination` | `Pagination`, `PaginationCaption`, `PaginationContent`, `PaginationEllipsis`, `PaginationItem`, `PaginationLink`, `PaginationNext`, `PaginationPrevious` |
| `select` | `Select`, `SelectContent`, `SelectGroup`, `SelectItem`, `SelectLabel`, `SelectScrollDownButton`, `SelectScrollUpButton`, `SelectSeparator`, `SelectTrigger`, `SelectValue` |
| `separator` | `Separator` |
| `table` | `Table`, `TableBody`, `TableCaption`, `TableCell`, `TableFooter`, `TableHead`, `TableHeader`, `TableRow` |
| `textarea` | `Textarea` |

72 exports. `HOST_DESIGN_PRIMITIVES_EXPORTS` in the SDK leaf is the single source
of truth; the host barrel `satisfies` it, so a removed or renamed export is a
host build failure rather than a run-time `undefined` inside somebody's package.

### Not in the list

The border floor also records `external-link.tsx`, `link.tsx` and
`text-link.tsx`. Those are **not** product primitives — they are the extensions'
own components (`vendor-extension-primitives.mjs`: *dialog.tsx / link.tsx are the
connector's OWN components, not registry items, so they are outside this
channel*), and no such file exists under `src/components/ui/`, so the host cannot
serve them. A package keeps its own copy of those, or folds them into its own
source; they never enter this contract.

## How a package migrates (the three lines a package changes)

1. **package.json** — do **not** declare `@cinatra-ai/design-primitives` as a
   dependency or a peer. The id is VIRTUAL: the host serves it at run time and no
   package is published under it, so *any* specifier — optional peer included —
   makes the install fail (`pnpm install` resolves peer specifiers and 404s on
   the id; measured on this branch, which is why the SDK does not declare one
   either). The package instead declares the contract version it builds against
   in its bundle preamble (`__cinatraDesignPrimitivesContract`), so the loader's
   fail-closed major check applies to it, and imports the contract itself from
   `@cinatra-ai/sdk-extensions/design-primitives-contract` for the id, the
   version and the frozen list.
2. **the imports** — replace every `from "./ui/<item>"` /
   `from "../components/ui/<item>"` with
   `from "@cinatra-ai/design-primitives"`.
3. **the copies** — delete `src/components/ui/<item>.tsx` for every primitive in
   the frozen list, and drop the package's entry from
   `scripts/extensions/vendor-extension-primitives.mjs`'s `VENDOR_MANIFEST`.

Then re-baseline the border gate
(`node scripts/extensions/self-rendering-extensions-border-gate.mjs
--write-baseline`), which refuses a baseline that grows. Nothing else moves: the
bundle road already externalizes the id, and the host's barrel and shim already
carry it.

## What this slice does NOT do

Honest boundaries, so slice 3 does not assume more than exists:

- **No package is migrated** and the border gate's baseline is untouched.
- **The typed contract names the exports, not their component types.** The
  contract module is React-free by design (importing it must never pull a second
  copy of anything), so `HostDesignPrimitivesModule` is `unknown`-valued: a
  migrating package types the values against its own React types.
- **`initHostModuleRegistry` still has no production call site on this head** —
  it has had none since it was introduced for React (epic #1620 M1 Slice A). This
  slice registers `designPrimitives` on that same road; whoever wires the shim
  for real supplies it, or the id resolves to `undefined` at run time. The
  load-boundary checks are wired at the loader seam and are inert for a bundle
  that declares no preamble field.
