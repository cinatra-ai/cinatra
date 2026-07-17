# Slice B host — live PROVE evidence (cinatra#1630, epic #1620 M1)

Live production-server verification of the four system `-artifact` base renderers
and the never-blank floor, captured against a real running instance. Screenshots
in `./screenshots/`.

## Environment

- Branch head: `ed166f03` (lane `1630-m1-slice-b-host`).
- Production build: `next build` GREEN in the clone. `BUILD_ID = SzRk-qak_v6VARzK5nPx1`.
- Server: `next start` (production) on port 3477 — NOT a dev server.
- Store: an isolated Postgres clone (`sliceb_host` on the verify stack, 127.0.0.1:5634)
  with `cinatra.agent_templates` emptied (boot-abort avoidance); Redis on 6579.
  Fresh `BETTER_AUTH_SECRET` / `CINATRA_ENCRYPTION_KEY`; the stale cloned JWKS row
  was cleared so Better Auth regenerated under the current secret.
- Session: a platform-admin org member minted through the real Better-Auth
  sign-up / sign-in / set-active flow; artifacts created through the REAL
  `POST /api/artifacts/upload` ingestion route (streamed blob, MIME from
  Content-Type). No fixture route, no direct DB seeding of representations.

### Boot registrar evidence (Gap i closed, live)

Server boot log line:

```
[system-artifact-renderers] registrar ready — 4 system base(s),
24 representation binding(s) reconcile per-org on first resolve.
```

The four bases anchored live: `@cinatra-ai/{image,pdf,audio,video}-artifact`.

## Assertion 1 — each MIME family renders via its base extension

The migrated host handlers were DELETED in the G2 cutover, so the DOM markers
below are emitted ONLY by the extension renderers. Their presence — with NO host
degraded notice (`[data-testid="artifact-renderer-degraded"]`) — proves the
extension path, not pixels alone.

| Family | Upload MIME | Extension marker (proof of path) | Screenshot |
| --- | --- | --- | --- |
| image | image/png | `article[data-artifact-renderer="image"][data-slot="detail"] > img` (SSR build-map fast path) | `01-image-render.png` |
| pdf | application/pdf | SSR emits the extension `<embed aria-label="PDF preview" type="application/pdf">`; under headless Chromium (`pdfViewerEnabled=false`) the extension's own react-pdf inline fallback then takes over — both are the pdf base | `02-pdf-render.png` |
| audio | audio/mpeg | `[data-audio-artifact="player"]` + native `<audio controls>` (renders the 0:01 fixture) | `03-audio-render.png` |
| video | video/mp4 | `<video aria-label="Video preview" controls>` (renders the teal 0:01 fixture) | `04-video-render.png` |

All four returned HTTP 200 with a non-blank body and no degraded notice. audio +
video ship DETAIL-only renderers and resolve at slot `detail` exactly as designed.

## Assertion 2 — failure → never-blank floor (per cut arm)

Every failure path renders a non-blank body; none reach a blank panel or the
route error boundary.

| Case | Input | Floor rendered | Screenshot |
| --- | --- | --- | --- |
| image (malformed) | garbage bytes, declared image/png | content re-sniffed to text/plain → the core escaped-plain-text floor (bytes shown safely escaped, no script execution) | `05-image-malformed.png` |
| pdf (malformed) | garbage bytes, application/pdf | pdf base still mounts (extension `<embed>`); the browser viewer's own error UI stands in — never blank | `06-pdf-malformed.png` |
| audio (malformed) | garbage bytes, audio/mpeg | non-blank floor (no degraded notice, no error boundary) | `07-audio-malformed.png` |
| video (malformed) | garbage bytes, video/mp4 | non-blank floor (no degraded notice, no error boundary) | `08-video-malformed.png` |
| non-served MIME | image/bmp (outside the preview-inline allowlist) | host generic "Preview unavailable for this file type" card (Name/MIME/Size/Origin/Created) | `09-bmp-host-fallback-floor.png` |
| forced generic | image/png + `?renderer=generic` | the generic-floor escape hatch: extension marker ABSENT, generic card present | `10-image-forcegeneric-floor.png` |

The bmp case also demonstrates the allowlist gating: a family MIME the byte route
would 415 falls to the generic floor rather than mounting a broken player.

## Assertion 3 — the dynamic (runtime-admitted) leg

Baseline captured: an `application/json` artifact renders via the generic floor
BEFORE any dynamic install (`11-json-before-install.png`). This is the correct
pre-install state — `application/json` has NO entry in the generated build map
(only the four bases do) and no admitted runtime renderer, so it floors.

Wiring verified (Gap ii closed structurally): the admission caller
`admitRuntimeArtifactRenderersFor*` is wired into both the boot extension-activation
phase (`src/lib/boot/phases/extension-activation.ts`) and the hot-activate path
(`src/lib/extension-runtime-activate.ts`), and runs at boot over the registered
artifact records.

Live end-to-end dynamic render NOT exercised — honest gap. In this environment:

- No package ships a `client-bundle.manifest.json` (none present on disk), so the
  boot admission scan finds nothing to admit.
- No signing trust root is deployed — boot logs `ExtensionSignatureBackfill:
  skipped (no-trusted-keys)`. Admission requires SRI + Ed25519 signature
  verification against a trusted key and is fail-closed, so nothing becomes
  loadable even if a manifest were present.
- `@cinatra-ai/json-artifact` is not present in this checkout and there is no
  published client bundle to install, so "install the published fixture through
  the real registry path" cannot be run truthfully here.

Consequently the malformed-payload → floor and archive → revocation sub-cases of
the dynamic leg were also not exercised live (they remain covered by the unit
suite: a real Ed25519-signed synthetic fixture drives admit/refuse, and
`retireByPackage` is wired into the lifecycle teardown). Deploying a signing
trust root plus a signed published client bundle is the owner-gated M1 acceptance
step and is out of scope for this environment. The zero-rebuild property holds
across all live renders above: `BUILD_ID` was unchanged (`SzRk-qak_v6VARzK5nPx1`)
throughout — no rebuild occurred after boot.
