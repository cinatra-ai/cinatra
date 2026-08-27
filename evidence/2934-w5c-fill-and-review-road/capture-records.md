# Capture records — cinatra#2934 W5c picture leg

## The environment

- Head photographed: `a85b2bbaaeb51b3bea4f5dc16f9fdd65bda22e94` (pull request 2998).
- Drawing graded against: the ratified drawing at the contract's pin
  `458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f` — `app-artifact-review.html` §VI, §IX, §X and
  `app-lifecycle-cards.html` §X, rendered in the capture browser and quoted verbatim.
- Database: a database of its own on the verify Postgres, created for this leg and dropped after it;
  Redis of the same verify stack. Both loopback-only.
- Runtime: the app's dev server (Turbopack, `CINATRA_RUNTIME_MODE=development`), the agent runtime
  container brought up from this checkout (`--profile wayflow`, 29 agents mounted, `/.health` `ok`),
  the bundled credential store, and the bundled dev registry seeded with 113 packages, so artifact
  bindings resolve. Not a production-equivalent build.
- Provider: **openai**, bound through the app's own `/setup/model` form. The key travelled from the
  operator's secret manager into the shipped field and was sealed by the app; it was never printed,
  logged or written to disk here. `CINATRA_TEST_LLM_PROVIDER` is set in nothing this leg started, and
  the driver refuses to run where it can see it.
- Models that answered: `gpt-5.5` and `gpt-5.5-2026-04-23`, read back from `usage_events` on this
  instance.
- Native MCP reached the instance through its configured public origin, set through the app's own
  development configuration screen and read back from the app's own settings endpoint.
- People: the instance administrator created through the app's own setup wizard (`Ada Admin`); the run
  owner (**Rita Owner**, `role=user`, organization `member`) and a second ordinary member
  (`Ben Bystander`) created through the app's own sign-up and joined through the app's own invite and
  accept. Every capture is signed in as the run owner — a person who owns the run and is **not** a
  platform administrator.
- Agents: `@cinatra-ai/email-outreach-agent` and `@cinatra-ai/blog-draft-writer-agent` with the four
  sub-agents the first one declares, installed through the product's own Upload Extension screen.
- Full window, 1440x900 at device scale 2, uncropped, light and dark, through the app's own theme
  control. Every capture was viewed before it was recorded.
- No pixel was edited. No transcript was seeded. No assistant was stubbed. No reload was faked.

## The one retry, and what decided it

Where a turn was served without its toolbox, the SAME words were sent again — never re-worded, never
replaced with an easier question. The retry is decided by the app server's own log for that turn's own
window (`424 (Failed Dependency)` / `MCP tool enumeration failed`), not by whether the answer was the
one wanted, and every attempt is stamped in `timeline.jsonl` with what the log said. A turn whose slice
carried no such line is kept exactly as it came back.

## sha256 of every recorded capture

```
b35e2ed636c422c1c8edee521988032aad9d1b42cec0a88c99caf0d645c77ca7  run-page__fill-no-submit__dark.png
c50e7dd16c7a9e78ecf589ad241e94dff3e33e5b02859171219194a3e9649ce8  run-page__fill-no-submit__light.png
135d97ed9582103d19e2760c1be6d1dafd06411f802c4d0adc6611a7d18ef6e7  run-page__question-no-press__dark.png
5621a399abbc82570a00fc322299037e272a83c45d7cf0a99275161cb9095cb6  run-page__question-no-press__light.png
e0681038b24e5c5c401bc542502d7c5b86c6b551bb45e037e4de2af2838625ad  run-page__submit-on-ask__dark.png
b411e2c0adc0cdf2b4bc3cfa23383858573b5f8bba770bfad55796b5e97779cc  run-page__submit-on-ask__light.png
65d1b3b0c587190f5c2dbf02d6a1508b823ab8244e9e43f8861442f0819c0e40  schedule__fill-no-submit__dark.png
4433267051b988a61c45b8c980ab050492ddbdfd231d55c1343968c87fe5fc99  schedule__fill-no-submit__light.png
be9ad7c7fb63c9e68538c541c3f2bee91788a05801de9ff8fbc23869e91eb239  step-by-step__attachment-reaches-run__dark.png
9d6254d8332f1d9de0657a4f2f3c1f92c68823a1e023322dc61d288859c90343  step-by-step__attachment-reaches-run__light.png
65cec21e104b7fb2c8f87a151fcd44f365656ccdff888027eec87c4ab1ee9d6b  step-by-step__draft-survives-reload__dark.png
5528e86e0cd92e343fff9c0ae5aee5ef0342d89551b5e125e05024286637d5f3  step-by-step__draft-survives-reload__light.png
cea69f1c8235964ae53c76c2cd82314f47b7f8f36dcbdf1260b639c9017fb28e  step-by-step__fill-no-submit__dark.png
2caefd98f386466458d50a21788d817552fe8e7de737f550f828558b09736a57  step-by-step__fill-no-submit__light.png
```
