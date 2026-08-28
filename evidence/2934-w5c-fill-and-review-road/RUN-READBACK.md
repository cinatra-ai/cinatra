# RUN-READBACK — every run this leg created, and what the database says about it

All rows read with `select` only. **No run, gate, park, record or review task was written by hand at
any point in this leg**, and the drivers carry no `insert`/`update` statement of any kind.

## The runs

| run | agent | what it is here | final row |
|---|---|---|---|
| `44915a33-b35a-42d9-9ace-9e36028fae18` | Blog Draft Writer Agent | the LIGHT run-page trio — fill, question, submit-on-ask — and the light schedule reading, all four frames taken in the context that sent each turn | `status=pending_trigger`; `input_params={"idea": {"title": "Why cadence beats bursts for blog reach"}}`; 11 window rows |
| `a6f9ac69-7da1-49e9-b274-c4b2e80f5e14` | Blog Draft Writer Agent | the DARK run-page fill and question readings | `status=pending_approval`; `input_params={}`; 10 window rows. Its submit-asking turn was refused authority (see the README's first observation), so the dark submit and schedule frames were taken on the run below |
| `a3faf470-97b5-43ee-9cb1-ca07e3051097` | Blog Draft Writer Agent | the DARK submit-on-ask and schedule readings | `status=pending_trigger`; `input_params={"idea": {"title": "Why cadence beats bursts for blog reach"}}`; 6 window rows |
| `d46a8013-5a6b-491a-a80f-3b8fcb789a8e` | Blog Draft Writer Agent | **the diagnosis** — one fill, read and photographed at the shutter, then the same context reloads and is read and photographed again | `status=pending_approval`; `input_params={}`; 3 window rows |
| `9cd8283f-4f8e-4699-97cd-a558df927073` | Email Outreach Agent | the LIGHT step-by-step fill reading | `status=pending_approval`; 5 window rows; one gate row `{"stepNumber": 1}` |
| `b2005bef-c494-4d39-b1f6-5c2714a4414f` | Email Outreach Agent | the DARK step-by-step fill reading | `status=pending_approval`; 5 window rows; one gate row `{"stepNumber": 1}` |
| `84d7beb6-19bd-461a-9ebb-ce0b38e7c664` | Email Outreach Agent | the LIGHT attachment reading — the window's own paperclip, then a fill, nothing submitted | `status=pending_approval`; 3 window rows; the person's row carries `campaign-brief.txt`, digest `576038005379a871f562e47022857a40c30371a389a38d872d0accc9a4816d11` |
| `eafd85cc-65f5-4fcd-962b-d582d5d36e3d` | Email Outreach Agent | the DARK attachment reading | `status=pending_approval`; 3 window rows; the same file and digest on the person's row |
| `52e7165a-008e-4b61-ba7f-5b6c717359bb` | Email Outreach Agent | **the route probe** — the paperclip, then a message that asked for the send; it proves the submit road carries the file and it is where the "Not authorized" page was reproduced | `status=pending_approval`; 3 window rows (the person's message with its attachment, the fill, `Submitted.`); **two** gate rows, `{"stepNumber": 1}` at `07:58:54.158718Z` and `{"stepNumber": 2}` at `08:00:31.323940Z` |
| `ce498762-da84-422e-a2d8-555c23378752` | Email Outreach Agent | a first step-by-step pass, in no picture — its attachment reading asked the assistant to READ the brief and was answered honestly that it cannot (README, second observation), and its submit-asking turn was refused authority | `status=pending_approval`; 10 window rows |

## What the window's own rows hold, per pictured reading

Every row below is `cinatra.agent_run_messages`, read after the turn with `select`.

- **run-page fill (light, `44915a33`)** — the person's message; an assistant row whose
  `content_json.fill` names the screen's ref and `values` the idea; an assistant row reading
  `Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.`
- **run-page question (light, `44915a33`)** — the person's message and one assistant row of drawn
  prose. No fill row, no gate row, `input_params` unchanged.
- **run-page submit-on-ask (light, `44915a33`)** — the person's message, a fill row, and an assistant
  row reading `Submitted.`; the run moved `pending_approval` → `pending_trigger` and `input_params`
  became the person's own words.
- **schedule fill (light, `44915a33`; dark, `a3faf470`)** — the person's message and the assistant's
  own fill sentence; `scheduledAt` read `2026-08-29T09:00` off the DOM at the shutter and the form's
  own button was not pressed.
- **step-by-step fill (light, `9cd8283f`; dark, `b2005bef`)** — the person's message, a fill row
  carrying the two values, and the platform's fill sentence. `field-senderName` stayed `""`, exactly
  as the message asked.
- **attachment (light, `84d7beb6`; dark, `eafd85cc`)** — the person's row carries the message AND the
  file (`artifactId`, `representationRevisionId`, `digest`, `mime: text/plain`, `originKind: upload`,
  `filename: campaign-brief.txt`); then the fill row and the fill sentence. Nothing submitted.
- **the submit road (`52e7165a`)** — the person's row carries the message and the same file; then the
  fill row; then `Submitted.`; then a second gate row. The file was on the submitted message.

## The identity every reading was taken as

`Rita Owner` / `owner@example.com` — `public.user.role` is the ordinary user role, `public.member`
gives `role=member` in the instance's organization, and the account footer in every frame draws that
person. The instance administrator is a different account and appears in no frame.
