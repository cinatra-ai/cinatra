# cinatra#2752 — the schema-config add-failure toast, before and after

Captured on a lane host against a **production-equivalent build** (`CI=true pnpm build`
+ `next start`, Next.js 16.2.10) of the appointment-schedules setup page
`/connectors/cinatra-ai/google-appointment-schedules-connector/setup`, signed in
as the platform-admin UAT account. Both repros are the ones evidenced by the
#2370 S4 run (E10, E11); the server payload is recorded next to every toast, so
the toast can be read against what the handler actually returned.

| Phase | Build | Toast tone | Toast text |
|---|---|---|---|
| before | `82298994e` (main at S3 cutover) | **success** | `Done.` |
| after | `c74f674a3` (this branch) | **error** | the handler's own message |

## before/ — the defect

* `E10-*` — `https://example.com/not-allowed` → server:
  `{"result":{"banner":"error","message":"Use a public Google Calendar appointment schedule link from calendar.app.google."}}`
  → toast `data-type="success"`, text **"Done."**. The list stays empty.
* `E11-*` — `https://calendar.app.google/appt-s4-does-not-exist` → server:
  `{"result":{"banner":"error","message":"Unable to load the appointment schedule page (404)."}}`
  → toast `data-type="success"`, text **"Done."**.

## after/ — the fix

* `E10-*` → toast `data-type="error"`, text
  **"Use a public Google Calendar appointment schedule link from calendar.app.google."**
* `E11-*` → toast `data-type="error"`, text
  **"Unable to load the appointment schedule page (404)."**

Zero console errors in both phases (`results.json` → `consoleErrors`).

## undeclared/ — the fail-safe's cost, measured

The fail-safe treats EVERY banner name the surface never declared as a failure.
This connector declares no banner field at all, so its SUCCESS answers are
undeclared too and now toast as errors. A real successful Add needs a reachable
`calendar.app.google` page, which this credential-free host cannot have, so the
handler's answer is canned at the network boundary (`page.route`) while the page,
the build and the shell stay real:

* `U1-saved` — stubbed `{"result":{"banner":"saved"}}` → toast `error`, "Action failed."
* `U2-deleted` — stubbed `{"result":{"banner":"deleted"}}` → toast `error`, "Action failed."

Remedy (connector-side, `@cinatra-ai/google-appointment-schedules-connector`):
declare the vocabulary its handlers already answer with — the shape every other
schema-config connector in the fleet already ships:

```json
{ "kind": "banner", "label": "Result", "variants": [
  { "name": "saved",   "tone": "success",     "message": "Appointment schedule added." },
  { "name": "deleted", "tone": "success",     "message": "Appointment schedule removed." },
  { "name": "error",   "tone": "destructive", "message": "Couldn't add the appointment schedule." }
] }
```

With that block the shell renders `saved`/`deleted` as success and still shows the
handler's own text on `error` (the server message wins over the static one).

## Drivers

`.s2752drivers/e2752-add-failure.mjs` and `.s2752drivers/e2752-undeclared-success.mjs`
on a lane host (`<lane-checkout>/s3-2722/`), sharing the #2370 S4 lane's `lib-auth.mjs`.
