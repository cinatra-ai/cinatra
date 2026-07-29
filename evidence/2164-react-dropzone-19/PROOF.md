# cinatra#2164 — `react-dropzone` 15 → 19.1.1 works-after evidence

Paired A/B captured at ONE base commit (`fa360364e`), same worktree, same
fixtures, same driver, same seeded database. Both sides ran against a REAL dev
boot on a lane-unique port in an isolated Chromium profile (never the shared
browser, never a fixture route). The narrative and the full breaking-change
reading — every intervening major — live in
`docs/internals/workflows/upgrade-track.md` §13.6.

## What the driver actually does

`drivers/dnd-driver.mjs` signs in through the real sign-in form, opens
`/configuration/extensions/upload` (the "File" tab — the only consumer of
`src/components/ui/dropzone.tsx`), then builds a genuine `DataTransfer` in page
context and dispatches `dragenter` → `dragover` → `drop` on the drop zone. That
drives react-dropzone's own `onDrop` → `getFilesFromEvent` → `fileAccepted`
path: it is a real drag-and-drop, not `setInputFiles` and not a click-to-pick
shortcut. It logs the file count the browser exposed on the `DataTransfer`, so
the record shows a real file rode the event.

Everything in the table below is machine-read rather than eyeballed:

- the upload **POST status** comes from the browser's own `response` event, not
  from an assumption;
- the **accessible name** is the COMPUTED name off Chromium's accessibility tree
  (CDP `Accessibility.getPartialAXTree`), not an `aria-label` presence check;
- the post-submit state is reached by waiting for the success **navigation**, so
  both sides are compared settled rather than mid-flight.

The app's first-party browser-e2e affordance `CINATRA_E2E_SETUP_BYPASS=true` was
set so a freshly-provisioned instance did not redirect every authenticated route
into the setup wizard. It bypasses the wizard only; the upload screen's own
`requireAuthSession()` and admin resolution still ran.

## Results

| Works-after obligation | 15.0.0 (before) | 19.1.1 (after) |
|---|---|---|
| rendered input `accept` | `application/zip,.zip` | `application/zip,.zip` |
| wrong type (`.txt`) rejected — root message | `Only .zip are allowed` | `Only .zip are allowed` |
| wrong type leaves file list empty | 0 items | 0 items |
| `.zip` accepted, parsed, preview rendered | yes | yes |
| upload `POST` response status | `303` | `303` |
| success navigation after submit | `/agents` | `/agents` |
| upload LANDS (`cinatra.agent_templates` row) | row created | row created |
| file-input computed accessible name | `Select an extension package Click here or drag and drop` | same* |
| console errors during the walk | 1, a hydration warning | 1, same warning kind |
| rapid double-drop | `["rapid-a.zip","rapid-b.zip"]` | `["rapid-b.zip"]` ← **the one delta** |

\* 18.0.2 added a blanket `aria-label="file upload"` that displaced the wrapping
`<label>`'s descriptive name. `DropzoneTrigger` now clears it — the single
first-party source change in this hop. Measured on 19.1.1 BEFORE the fix the
computed name read `"file upload"`; after the fix it is the pre-hop string.

The landed row is what makes this a completed upload rather than a render: the
row was deleted before EACH side's run, and that side's drop created a fresh
`@cinatra-ai/lane2164-dnd-proof-agent` row.

**The rapid double-drop row is a real behavioural delta, recorded not fixed.**
react-dropzone 19.1.0 made every drop start a supersession-guarded processing
run, so a newer drop aborts the earlier run — even with no `validator`
configured. A drop landing while an earlier drop is still being processed is
therefore latest-wins on 19 where 15 processed both. The sole consumer is a
single-file replacement picker whose intent is exactly latest-wins, and with the
plain-`File` reads this surface performs the overlap window closes within a
microtask, so the two events had to be synthesised. See §13.6.7 for the full
reasoning, including why the window is not inherently same-tick.

## Screenshots

`screenshots/<side>-NN-*.png`, same six steps per side:

| # | step |
|---|---|
| 01 | upload surface idle |
| 02 | rejection path — `.txt` dropped, "Only .zip are allowed", file list still empty |
| 03 | accept path — `.zip` dropped, parsed, preview rendered |
| 04 | pre-submit state |
| 05 | post-submit (settled on the success destination) |
| 06 | rapid double-drop outcome |

## Gates

```
pnpm test:root   15.0.0 : 1167 files passed | 3 skipped ; 14023 passed | 22 skipped | 3 todo
                 19.1.1 : 1167 files passed | 3 skipped ; 14023 passed | 22 skipped | 3 todo
                 final  : 1167 files passed | 3 skipped ; 14023 passed | 22 skipped | 3 todo
tsgo --noEmit    clean
pnpm build       clean on 19.1.1  (production bundler — the arm that would catch
                 an exports-map / ESM-vs-CJS fault the dev server can hide)
```

`eslint src/components/ui/dropzone.tsx` reports byte-identical output before and
after the change (9 pre-existing `no-empty-object-type` errors + 1
unused-directive warning, none of them this hop's). The repo-wide `eslint .`
exit code is known pre-existing debt that CI deliberately does not gate on —
see the rationale comment in `.github/workflows/ui-design-system-gate.yml`.

## Fixtures

`fixtures/lane2164-agent.zip` is a minimal valid OAS v26.1.0 Flow package
(`agent.json` + `manifest.json` + `package.json` + `LICENSE`), STORED rather
than deflated because the client-side reader in `import-form.tsx` does not
inflate. `fixtures/lane2164-notes.txt` is the rejection-path fixture.

## Reproducing

```sh
PORT=<lane-port> CINATRA_E2E_SETUP_BYPASS=true pnpm dev

LANE_PORT=<lane-port> \
LANE_OUT=<screenshot-dir> \
LANE_FIXTURES=evidence/2164-react-dropzone-19/fixtures \
LANE_EMAIL=<proof-account> LANE_PASSWORD=<proof-password> \
LANE_RDZ_VERSION=$(node -p "require('react-dropzone/package.json').version") \
node evidence/2164-react-dropzone-19/drivers/dnd-driver.mjs after
```

`drivers/signup.mjs` creates the proof account through the real sign-up form; it
needs an admin role to reach the upload screen.
