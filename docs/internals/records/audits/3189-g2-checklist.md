# G2 clause checklist — dialog, dropdown-menu, dropzone, field, form, input, input-group, label (#3189)

The audit record of the G2 clauses of the components drawing, read at the docs and application shas below. Each clause
is quoted verbatim with its drawing line, graded against the code at the application sha, and given its standing.


| Item | Value |
|---|---|
| docs main sha (read) | `f0f7360d51ab2bcfe021236ce3c9cccd925ba151` (committed 2026-10-20T19:13:10Z). Drawing `references/design/application-design-components.html`, 1499 lines. Rules of the road: `references/design/design-system.html` §VI, L647–704 |
| pin and drift | `tests/e2e/design/conformance-pins.json` @ `2e757732` pins `app-components` (`source: published`) at manifestSha256 `a5361f3e5226906f…`. The sha256 of `references/design/conformance/app-components.json` at docs main is `a5361f3e5226906f…`, the same value. **No drift.** The manifest lists `input`, `select`, `dialog` and `form` with empty fields/actions/states. The context-menu section (L1049–1066) has no conformance id, so no live reading pins it |
| cinatra main sha (read) | `2e757732a9fc08ec2f88296f87331079c8125cd5` |
| Governing sections, and why | **Components "Input / Textarea"** (`data-conformance-id="input"`, annotations L391, prose L399): input and input-group. **"Select / Dropdown"** (L405–414; the component line names `<DropdownMenu />`): dropdown content. **"Dialog / Sheet"** (L420–429): dialog. **"Form / Field / Label"** (L685–691; the component line names `<Form />, <Field />, <Label />`): field, form and label. **"Context menu"** (L1049–1066; the component line names `<ContextMenu />, <DropdownMenu />`, and the prose says "the chevron DropdownMenu share[s] this surface"): dropdown rows, shortcuts, destructive items and separators. **design-system §VI rules 2, 6, 8** (L662, L685, L697): dropzone, which has no section of its own, plus the disabled input |
| Token resolution | Light `.cinatra` palette, `src/app/globals.css`: `--background` #f1f1ed (L189), which is the drawing's `--paper` #f1f1ed. `--popover: var(--surface-strong)` #ffffff (L216). `--border`/`--line` rgba(21,33,58,0.14). `--input: var(--line-control)` → `--line-strong` #15213a. `--ring: var(--accent)` #364e81, the drawing's indigo `--blue`. `--destructive` → `--cinatra-red` #a6384f, the drawing's `--red`. `--muted-foreground` #5a6477, the drawing's slate. **`bg-accent` → `--color-accent: var(--accent-soft)` #e6ede7 (sage), @theme L609. This is not the drawn indigo soft tint rgba(54,78,129,0.06).** `bg-indigo-ink/[0.06]` gives #364e81 at 6% (the precedent is `combobox.tsx:304–318`). Cascade: Tailwind v4 utilities are imported `layer(utilities)` (L5). `globals.css` L429–437, L1250–1259 and L1263–1267 sit outside any `@layer`, so their `box-shadow` beats every layered utility, including the `ring-*` box-shadow |
| Code | Host: `src/components/ui/dialog.tsx` (149 lines), `dropdown-menu.tsx` (275), `dropzone.tsx` (841), `field.tsx` (238), `form.tsx` (165), `input.tsx`, `input-group.tsx` (156), `label.tsx`, and `src/app/globals.css`. Portable host copies (not pack-vendored): `packages/sdk-ui/src/ui/{dialog,dropdown-menu,input,label}.tsx`. `input` and `label` are identical to the host apart from import paths. `dropdown-menu` is identical apart from imports and a comment. `dialog` differs at L72. Pack-vendored `src/components/ui/` copies inside the extension packs are excluded (G0) |

## Checklist (counted clauses)

Ids carrying the eight labels on record (DM5b, DM8, DM9a, Fi2, Fi5, Fi6, F5, I5b) are **reconstructed** by content and
drawing order. The lost checklist's numbering cannot be read back, so each of these mappings is a reading (Doubt 1).

| id | Clause (verbatim) and source @ docs `f0f7360d` | Assertion form | main standing @ `2e757732` | Prior coverage | Pin-drift dep. |
|---|---|---|---|---|---|
| D1a | "--paper (= pages)" (L421); "Modal dialogs use --paper — the same background as pages" (L429) | computed-style. Host `[data-slot=dialog-content]` background = #f1f1ed | **meets.** `dialog.tsx:72` `bg-background` | `dialog-drawing-conformance.test.tsx:69–77`; leg1 e2e `primitive-wave-leg1.spec.ts:642` | none |
| D1b | the same clause, for the portable `DialogContent` the app renders through `@cinatra-ai/sdk-ui` (`AppDialog`, `packages/sdk-ui/src/app-dialog.tsx`) | class + compiled. The rendered sdk-ui content's winning background resolves to `--background` in both palettes | **departs.** `packages/sdk-ui/src/ui/dialog.tsx:72` `bg-popover` (white #fff). Leg 1 (`47d704a69`) fixed the host line only. The same line's `rounded-lg` is not this clause (the 8px corner is the app-components Dialog clause) and is handed over, not counted here | none | none |
| D2 | "starts below 4rem navbar" (L421); "Overlay top: 4rem so it doesn't cover the navbar" (L429) | computed-style. Overlay `top` = 64px | **meets.** `dialog.tsx:40` `top-16`; `globals.css:1298` `[data-slot="dialog-overlay"]{top:4rem}` | leg1 e2e L641–714 | none |
| D3 | "dim overlay" (L421) | computed-style. Overlay background has alpha > 0 and < 1 | **meets.** `dialog.tsx:40` `bg-black/50`. The drawn value rgba(21,33,58,0.55) is EP1 | leg1 e2e L641–714 | none |
| D4 | "etched header rule" (L421); "Dialog header uses an etched paired-line rule for separation" (L429) | computed-style. Header `::after` draws the paired line-strong rule | **meets.** `dialog.tsx:96` `divider-etched-after`; `globals.css:336–339` | `dialog-drawing-conformance`; leg1 e2e L676 | none |
| DM1 | "popover token" (L406) | class. Content uses `bg-popover` | **meets.** `dropdown-menu.tsx:52` | `dropdown-menu-drawing-conformance.test.tsx` | none |
| DM2 | "surface-strong" (L406); "Open popover sits on --surface-strong" (L414) | computed-style. Content background #fff | **meets.** `:52` `bg-popover` → `--popover: var(--surface-strong)` | unit test; leg1 e2e L716–765 | none |
| DM3 | "inherits input chrome" (L406); "Trigger mirrors Input chrome" (L414) | — | **CANNOT-TELL.** `DropdownMenuTrigger` (`dropdown-menu.tsx` Trigger) draws no chrome of its own and is rendered `asChild` by each consumer. The section is "Select / Dropdown", and the drawn trigger is a Select trigger. Neither the drawing nor the code says whether this clause binds the bare DropdownMenu trigger (a button, an icon, a chevron) or only the Select trigger (G1). Leg 1 recorded it as n/a | leg-1 unit test "trigger n/a" | none |
| DM4 | "scrollbar-thin" (L406); "Use scrollbar-thin on long lists" (L414) | computed-style. `scrollbar-width: thin` on content | **meets.** Base layer `globals.css:1071` `*{scrollbar-width:thin}`; content `:52` `overflow-y-auto` | unit test; leg1 e2e | none |
| DM5a | "Open popover sits on --surface-strong with the same hairline border" (L414) — content | class/computed. Content has a 1px `--line` border | **meets.** `:52` `border border-line` | unit test; leg1 e2e | none |
| DM5b | the same clause — **sub-menu content** | class. `DropdownMenuSubContent` has `border border-line` | **departs.** `dropdown-menu.tsx:253` `rounded-lg bg-popover p-1 … shadow-lg ring-1 ring-foreground/10`, with no border (the same at `packages/sdk-ui/src/ui/dropdown-menu.tsx:253`) | none | none |
| DM6 | "slightly higher shadow" (L414) | class. Content shadow is above the input's `shadow-xs` | **meets.** `:52` `shadow-md` (sub `:253` `shadow-lg`) | unit test; leg1 e2e | none |
| DM7 | "Right-click context menus and the chevron DropdownMenu share this surface" (L1066); "surface-strong popover" (L1054) | class. Same surface as DM2 | **meets.** `:52` | unit test | none |
| DM8 | "indigo tint active row" (L1054); "Rows highlight on the indigo soft-tint" (L1066); drawn active row rgba(54,78,129,0.06) | class + computed. Highlighted row background = #364e81 at 6% | **departs.** `focus:bg-accent` → #e6ede7 sage at Item `:82`, CheckboxItem `:104`, RadioItem `:148`, SubTrigger `:235` (and `data-open:bg-accent` `:235`). The same at the sdk-ui copy `:82/:104/:148/:235`. The portable theme the sdk-ui copy pairs with has no `--color-indigo-ink` (`packages/design/src/theme.css:13-66`; the host declares it only in `globals.css:137,631`), so the fix needs the token there too | none (leg-1 unit test does not read the row highlight) | none |
| DM9a | "mono shortcut hints" (L1054); "keyboard shortcuts sit right-aligned in mono slate" (L1066) — **mono slate** | class. Shortcut has `font-mono` and stays `text-muted-foreground` on a highlighted row | **departs.** `dropdown-menu.tsx:208` has no `font-mono`, and `group-focus/dropdown-menu-item:text-accent-foreground` turns it to ink on focus. The Item's `not-data-[variant=destructive]:focus:**:text-accent-foreground` (`:82`) does the same. CheckboxItem `:104`, RadioItem `:148` and SubTrigger `:235` carry no `group/dropdown-menu-item`, and their own `focus:**:text-accent-foreground` turns the shortcut ink. The same in sdk-ui `:208` | none | none |
| DM9b | the same sentence — **right-aligned** | class. `ml-auto` | **meets.** `:208` `ml-auto` | none | none |
| DM10 | "red destructive item" (L1054); "destructive items take brand red" (L1066) | class. `data-[variant=destructive]:text-destructive` (#a6384f) | **meets.** `:82` | unit test | none |
| DM11 | "hairline group breaks" (L1054); "Group with the 1px hairline, never the etched paired rule" (L1066) | class. Separator `h-px bg-border`, no etched class | **meets.** `:194` | unit test | none |
| Dz1 | design-system rule 8 "White means interactive" (L697) | class. Drop area `bg-surface-strong` | **meets.** `dropzone.tsx:459` | leg-1 unit test ("THE DRAWING IS SILENT ON THIS PRIMITIVE") | none |
| Dz2 | rule 2, focus rings use indigo #364E81 (L662) | class. `focus-visible:ring-ring` | **meets.** `:459` `focus-visible:ring-2 focus-visible:ring-ring`. The drop area is a `div`, so the unlayered input rules (I5b) do not reach it | leg-1 unit test | none |
| Dz3 | rule 6 "Hairlines are navy, not grey" (L685) | class. `border-input` → line-strong | **meets.** `:459` | leg-1 unit test | none |
| Fi1 | "Label · 12px · 600" (L686) — `FieldLabel` | class. Delegates to `Label` | **meets.** `field.tsx:106–114` → `label.tsx:15` | `field-drawing-conformance.test.tsx:102–112` | none |
| Fi2 | "Label · 12px · 600" (L686) — **`FieldTitle`**, which renders `data-slot="field-label"`, the field's other label slot | class. `text-xs font-semibold` | **departs.** `field.tsx:121–123` `text-sm font-medium` (14px/500) | none | none |
| Fi3 | "Helper · 11px · muted" (L686) | class. `FieldDescription` `text-[11px] text-muted-foreground` | **meets.** `field.tsx:136` | `field-drawing-conformance.test.tsx:59–60` | none |
| Fi4a | "gap 4–8px" (L686) — the Field root | class + compiled. Field `gap` within 4–8px | **meets.** `field.tsx:55` `gap-2` (8px) | unit test | none |
| Fi4b | "gap 4–8px" (L686) — **`FieldContent`**, which stacks label, control and helper in the leg-1 fixture and label and helper in the checkbox/radio rows | class + compiled. FieldContent `row-gap` within 4–8px | **departs.** `field.tsx:93` `gap-0.5` (2px). The leg-1 fixture puts label, input, helper and error inside it (`field-drawing-conformance.test.tsx:37-44`); production rows use it at the default (`configuration/development/page.tsx:89`, `configuration/execution/page.tsx:175,206`, `schema-config-connector-form.tsx:623,750,775,1642`). | none | none |
| Fi5 | "error swaps helper red" (L686); "helper or error text below. Errors swap helper text colour to brand red" (L691) | class + DOM. The error takes the helper's place and size (11px), in red; the helper is not drawn beside it; nothing else in the field turns red | **departs.** `FieldError` `field.tsx:216–219` `text-sm` (14px). It renders beside `FieldDescription` and does not replace it. `fieldVariants` `:55` `data-[invalid=true]:text-destructive` turns the whole field red (label and typed text included) | `field-drawing-conformance.test.tsx:67–71` pins only `text-destructive` | none |
| Fi6 | "and add aria-invalid to the input" (L691) — Field | — | **CANNOT-TELL.** The clause states the rendered error state. Form meets it through `FormControl` (`form.tsx:117`, F6). The unmanaged `Field` receives no error state, only a consumer-set `data-invalid` (`field.tsx:55`); the drawing does not say whether the primitive must copy that onto its control or the consumer sets `aria-invalid` itself, as the leg-1 fixture does (`field-drawing-conformance.test.tsx:40`). No production caller sets `data-invalid` (grep at `2e757732`), so no rendered error state exists to grade. | the test sets the attribute itself | none |
| Fi7 | "labels above inputs, helper or error text below" (L691) — order | DOM order | **meets.** Vertical `fieldVariants` `:55`; test `:84–96` | unit test | none |
| F1 | "Label · 12px · 600" (L686) — `FormLabel` | class. Delegates to `Label` | **meets.** `form.tsx:95–98` | `form-drawing-conformance.test.tsx` | none |
| F2 | "Helper · 11px · muted" (L686) | class | **meets.** `form.tsx:130` `text-[11px] text-muted-foreground` | `form-drawing-conformance.test.tsx:84–88` | none |
| F3 | "gap 4–8px" (L686) | class | **meets.** `form.tsx:81` `grid gap-2` | test `:93–94` | none |
| F4 | "labels above inputs, helper or error text below" (L691) — order | DOM order | **meets.** | test `:131–132` | none |
| F5 | "error swaps helper red" (L686); "helper **or** error text below. Errors swap helper text colour to brand red" (L691) | DOM + class. When the field errors, the helper slot shows the error in red at 11px, and the description is not also drawn; the label keeps its ink | **departs.** `FormDescription` (`form.tsx:130`) stays rendered beside `FormMessage` (`:136–153`, 11px red), so helper **and** error show. `FormLabel` `:95–98` `data-[error=true]:text-destructive` turns the label red, and the leg-1 test pins that (`form-drawing-conformance.test.tsx:112–116`) | test `:101–116` pins the current behaviour | none |
| F6 | "and add aria-invalid to the input" (L691) — Form | DOM | **meets.** `FormControl` `form.tsx:109–118` | test `:119–127` | none |
| I1 | "surface-strong" (L391); "Always pure white background" (L399) | class + computed | **meets.** `input.tsx:11` `bg-surface-strong`; `globals.css:429–437` | `input-drawing-conformance` | none |
| I2 | "line-strong border" (L391); "Border is the strong navy hairline" (L399) | class | **meets.** `:11` `border border-input` → line-strong | unit test | none |
| I3 | "7px radius" (L391) | class | **meets.** `:11` `rounded-[7px]` | unit test | none |
| I4 | design-system rule 8 "White means interactive" (L697) — disabled input | class | **meets.** `:11` `disabled:bg-input-fill/50` | unit test (cites rule 8) | none |
| I5a | "focus = ring indigo" (L391); "Focus ring picks up --ring (indigo)" (L399) — **focus border** | class + computed | **meets.** `:11` `focus-visible:border-ring` (no unlayered rule sets `border-color`) | unit test | none |
| I5b | the same clause — **the ring** | computed-style. On `:focus-visible` the input's `box-shadow` carries a ring in `--ring` | **departs.** `:11` `focus-visible:ring-3 focus-visible:ring-ring/50` is layered. Unlayered `.cinatra input:not(…)` `globals.css:429–437` sets `box-shadow: none`, so the ring never draws. Dark mode does the same through `.dark input` `:1263–1267`. Only the border changes on focus | unit test pins the class only; no live focus reading exists | none |
| IG1 | "surface-strong" (L391), for the compound input | class | **meets.** `input-group.tsx:17` `bg-surface-strong`; `globals.css:433` | `input-group-drawing-conformance` | none |
| IG2 | "line-strong border" (L391) | class | **meets.** `:17` `border border-input` | unit test | none |
| IG3 | "7px radius" (L391) | class | **meets.** `:17` `rounded-[7px]` | unit test | none |
| IG4 | "Focus ring picks up --ring (indigo). Use InputGroup for compound inputs" (L399) — **the group's ring** | computed-style. With the inner control focused, the group's `box-shadow` carries the ring | **departs.** `:17` `has-[[data-slot=input-group-control]:focus-visible]:ring-3 …:ring-ring/50` is cancelled by unlayered `.cinatra [data-slot="input-group"]{box-shadow:none}` `globals.css:433–437` (dark `:1266`). **Not on the record of 8** (Doubt 2) | `input-group-drawing-conformance.test.tsx:94–101` pins the class only | none |
| IG5 | "Use InputGroup for compound inputs with addons" (L399) — one surface | class. The inner control draws no border, background or ring of its own | **meets.** `input-group.tsx` control `focus-visible:ring-0`; `globals.css:426–428` comment and exclusions | test `:90` | none |
| L1 | "Label · 12px" (L686) | class | **meets.** `label.tsx:15` `text-xs` | `label-drawing-conformance` | none |
| L2 | "Label · … · 600" (L686) | class | **meets.** `:15` `font-semibold` | unit test | none |

Counted: 48 clauses. By standing: meets 36, departs 10 (D1b, DM5b, DM8, DM9a, Fi2, Fi4b, Fi5, F5, I5b, IG4), cannot-tell 2 (DM3, Fi6).
An earlier reading counted 35 clauses / 25 meet / 8 depart / 2 cannot-tell. The difference is a granularity difference: this
record splits D1, DM5, DM9, I5, Fi1/Fi2 and Fi4 into host/portable or part clauses, and counts dropzone and the input group on
their own. The earlier reading's second cannot-tell cannot be read back (Doubt 1); this record's second cannot-tell is Fi6.

Form tally (main form per row): class 33 (D1b and DM8 also compiled; Fi4a, Fi4b compiled), computed-style 8 (D1a, D2, D3, D4, DM2, DM4, I5b, IG4), DOM 3 (Fi7, F4, F6), DOM + class 2 (Fi5, F5), none 2 (DM3, Fi6, cannot-tell).

Not counted, with the reason:
- "right-side sheets sit at full-height" (L429). That clause is about Sheet, not one of the G2 items.
- "Use InputGroup for compound inputs with addons" (L399), read as usage guidance for consumers. Only its one-surface reading is counted (IG5).
- The Select trigger, the cmdk list and "check on selected" (L406, L1002). These belong to Select/Combobox (G1).
- Dropzone description `text-sm` (`:490`) and messages `text-[0.8rem]` (`:620`, `:647`). The Form section does not name the dropzone, and the drawing has no dropzone section.
- The InputGroup addon type (muted `text-sm`). It is not drawn.
- `FieldLegend` `field.tsx:33` (`font-medium text-sm|text-base`). It is a fieldset legend, a section heading the drawing does not draw. It is not a field label.
- Aria-invalid **ring** (`aria-invalid:ring-3 ring-destructive/20`, input `:11`, textarea), which the same unlayered rule cancels. The drawing draws no invalid ring (Notes 2).

## Drawn-example values: listed, not counted as clauses

| EP | Drawn value | Code | Note |
|---|---|---|---|
| EP1 | Dialog overlay rgba(21,33,58,0.55) (navy) | `bg-black/50` `dialog.tsx:40` | "dim overlay" is met; the hue is an example value |
| EP2 | Input 32px tall, padding 0 12px, 13px font | `h-8`, `px-2.5` (10px), `text-base md:text-sm` (14px) | example values |
| EP3 | Label margin-bottom 6px, helper margin-top 4px | Field `gap-2` (8px), FormItem `gap-2` | within the stated "gap 4–8px" |
| EP4 | Shortcut mono 10.5px | `text-xs` (12px) `tracking-widest` | the size is an example value; mono is the clause (DM9a) |
| EP5 | Context-menu row padding, 1px `var(--line)` separator | `px-1.5 py-1`; `h-px bg-border` | separator met (DM11) |
| EP6 | Label colour `var(--ink)` | Label inherits | example |

## Notes

1. Rule 4 (drawing self-consistency): the Select/Dropdown section and the Context menu section both govern DropdownMenu, and they agree (surface-strong, hairline). DM7 is counted once, as the shared-surface sentence.
2. The I5b/IG4 mechanism is the cascade, not the classes: every unit test that reads `className` passes at the base. Only a computed-style reading, or a source reading of `globals.css`, sees the cancelled ring. The same unlayered rule also cancels the Select trigger's ring (`[data-slot="select-trigger"]`, `globals.css:434`) and the textarea's (`:432`, dark `:1265`). They are not counted here. The textarea is G4's TX4; it departs at `2e757732` and is fixed in A3c, in the same block as I5b. The Select trigger belongs to G0.
3. `.lifecycle-fields-subordinate` (`globals.css:1398–1430`) removes the ring with `!important` on purpose ("A BOX DRAWN ON FOCUS IS STILL A BOX"). A fix for I5b/IG4 must leave that rule winning.
4. Dark palette not graded (rule 3). The dark `.dark input` rule cancels the ring the same way. The dark palette carries `.dark`, not `.cinatra` (`src/app/providers.tsx:48`), so the fix names both classes.
5. The leg-1 tests all read "NO DEPARTURE FOUND" for these primitives. DM5b, DM8 and DM9a fall on parts those tests do not render (sub-content, highlighted row, shortcut). Fi5/F5 are pinned the other way (the form test pins the red label).

## Remains

- Every departure is fixed in three parts, A3a / A3b / A3c. No open PR touches `src/components/ui/{dialog,dropdown-menu,dropzone,field,form,input,input-group,label}.tsx` or `packages/sdk-ui/src/ui/*` (open-PR read 2026-10-21 ~11:40Z, 59 open PRs). #4010 (draft) touches `src/app/globals.css` (Badge block L418–425 area), next to the input rule at L429.
- DM3 stays a cannot-tell until the drawing says whether the bare DropdownMenu trigger takes Input chrome.
- Fi6 stays a cannot-tell until the drawing says whether the unmanaged Field must mark its own control. Both go to the 3189 cannot-tells.
- The textarea ring (G4 TX4) is fixed in A3c; the reading goes to the G4 owner.
- The Select-trigger ring cancellation (Notes 2) is handed to the G0 owner as a reading; A3c's restoring block is the extension point.
- The sdk-ui `DialogContent` corner (`rounded-lg`, `packages/sdk-ui/src/ui/dialog.tsx:72`) is handed to the owner of the app-components Dialog-corner clause as a reading.

## Doubts

1. The labels DM5b, DM8, DM9a, Fi2, Fi5, Fi6, F5 and I5b are mapped by content. The lost checklist's own clause texts cannot be read back. The mapping of Fi2 (FieldTitle type), Fi5 (error size, swap and whole-field red) and Fi6 (aria-invalid wiring) is the least certain. The record's second cannot-tell is unknown.
2. IG4, D1b and Fi4b are departures this record finds and the record does not name. IG4 may have been folded into I5b in the lost copy. D1b falls under the host/portable parity precedent (`src/app/__tests__/control-token-parity.test.ts`: "Fixing only the host copy leaves the reported defect on screen").
3. An earlier reading of Fi6 read the prose "add aria-invalid to the input" as binding on the Field primitive. This record keeps it a cannot-tell (the table row gives the reason).
