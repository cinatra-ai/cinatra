# Gemini 3.5 development integration (#1714)

The development integration moves the connector default, core model policy and
media transcript agent together. The one core commit pins both companion
repositories; there is no state in this train that allows a retired text model.

## Pinned inputs

- Gemini connector: `29e0909da0e056097f0d82345e25ca8f44bdaaae`. Its declared
  default and sole text/media model are `gemini-3.5-flash`. Generation, streaming
  and uploaded-file generation use that default when the caller omits a model.
- Media transcript agent: `dad157fbc8e6809035c734d6f463218e48f257b7`. Both the
  OAS requirement and its bridge call require 3.5 Flash with `media_input`.
- The newer media commit `20863f3664e0c3beac0469e043d885d128a8b649` exposes an
  optional `title` StartNode input. Current core validation rejects that shape
  because exposed start inputs must be required. Its #3096 integration must
  resolve that contract separately; the pin above already supplies the Gemini
  migration without incorporating the incompatible title change.

Image-generation models are a separate capability. This text/media catalog
change does not rename image model IDs to a text model.

## Pricing and live verification

Gemini text/media pricing comes from the existing online LiteLLM sync into the
pricing store. No hardcoded 3.5 price replaces an old 2.5 price in the fallback
table or database bootstrap. A call whose model has not yet been synced reports
unknown cost. The sync-to-cost regression verifies insertion and subsequent
price updates, as well as absence of retired-model fallback rates.

On 2026-09-19 the authenticated Gemini API returned 200 for `gemini-3.5-flash`
and 404 for `gemini-3.5-pro`. A real 4.145-second WAV upload was transcribed by
3.5 Flash, reproducing both independent markers, "blue lantern" and "42".
Usage reported 104 AUDIO prompt tokens. The uploaded file was deleted after
the check. The source WAV SHA-256 was
`c947fcfebb3723e57be695810f3c8072082d78d5f43e7d7b19d425aab36b87ad`.
This live service check supplements adapter wire tests and pinned-agent OAS
validation; it is not an attestation of a completed in-app agent run.

## Development acceptance and release acceptance

The development pin boundary is available for dependent implementation and
tests without waiting for a coordinated release cut. It does not, by itself,
meet #1714's published-release acceptance criterion. The release owner must
publish both compatible companions and update the final release pin boundary
atomically. Keep #1714 open until that release evidence is attached. Do not
publish the connector alone as completion of this train.

Before a release cut, repeat the authenticated model-availability and uploaded
media checks. Add 3.5 Pro only after it is API-key-servable and its declaration,
pricing sync and media checks are verified together.
