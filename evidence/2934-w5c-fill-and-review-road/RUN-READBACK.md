# RUN-READBACK — every run this leg created, and what the database says about it

All rows read with `select` only. **No run, gate, park, record or review task was written by hand at
any point in this leg**, and the drivers carry no `insert`/`update` statement of any kind.

## The runs

| run | agent | what it is here | final row |
|---|---|---|---|
| `ac70cd70-bf6d-4c70-a60b-c947eca64318` | Blog Draft Writer Agent | the run page's submit-on-ask reading, the schedule reading, and the armed-trigger tab | `status=armed`; `input_params={"idea": {"title": "Why cadence beats bursts for blog reach"}}`; trigger `scheduled` / `2026-08-29T07:00:00Z` / `Europe/Berlin` / `released_at=NULL` |
| `512836b7-18c9-408e-9c10-c7d49e418cab` | Blog Draft Writer Agent | the run page's question reading | `status=pending_approval`; `input_params={}` |
| `3fa04248-f674-4b77-abeb-e5b6dd049139` | Blog Draft Writer Agent | the run page's fill reading | `status=pending_approval`; `input_params={}` |
| `3c694cde-4d6c-4fbd-8408-7e0a209e3e74` | Email Outreach Agent | the first step-by-step pass; in no picture (see the second observation in the README) | `status=pending_approval` |
| `89f947a2-3f48-42b0-8a7e-5f46cecf311a` | Email Outreach Agent | the step-by-step readings — draft, fill, attachment | `status=pending_approval` at step 2; two gate rows, `{"stepNumber": 1}` at `03:37:08.405230Z` and `{"stepNumber": 2}` at `03:41:25.695801Z` |
| `baa08154-209c-41c4-8f0a-ee88a78373e1` | Blog Draft Writer Agent | the review page's two readings | `status=failed`, `error=WayFlow task failed`; its artifact produced review gate `lifecycle-review:367341bf…`, now `resolved` / `changes_requested` at `03:56:22.518980Z` |
| `lifecycle-repair-run:a9fa4445-8b15-489c-b7e8-7d59bc61ed71` | Blog Draft Writer Agent | the repair the request for changes put in flight | `status=pending_approval`, parked on the producer's own setup gate; `lifecycle_repair.successor_gate_id` still NULL |

## The window's own rows, per cell

Every row below is `cinatra.agent_run_messages`, in sequence, read after the turn.

**Run page — the fill (`3fa04248`)**

| seq | role | content | at |
|---|---|---|---|
| 1 | user | `make the idea "A weekly publishing rhythm beats a burst of posts" and leave everything else as it is` | `03:28:46.197Z` |
| 2 | assistant | *(the fill row — `values` for the screen, no text)* | `03:29:00.171Z` |
| 3 | assistant | `Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.` | `03:29:02.251Z` |

**Run page — the question (`512836b7`)**

| seq | role | content | at |
|---|---|---|---|
| 4 | user | `what is this field for?` | `03:25:25.789Z` |
| 5 | assistant | `The **idea** field tells the Blog Draft Writer Agent what blog concept to turn into a draft.` … | `03:25:39.862Z` |

The stored text keeps its markdown; what changed at this head is that the WINDOW now draws it. The
frame's DOM readback for that bubble: `strong=1`, `tables=0`, raw `**` `=0`, raw `|` `=0`.

**Run page — the submit on ask (`ac70cd70`)**

| seq | role | content | at |
|---|---|---|---|
| 6 | user | `set the idea to "Why cadence beats bursts for blog reach" and send it` | `03:09:56.367Z` |
| 7 | assistant | *(the fill row)* | `03:10:11.232Z` |
| 8 | assistant | `Submitted.` | `03:10:16.566Z` |

Two rows for one message — a fill, then the press's own answer — and `input_params` afterwards is the
person's own words.

**The schedule screen (`ac70cd70`)**

| seq | role | content | at |
|---|---|---|---|
| 9 | user | `set it for tomorrow at 9 in the morning, Berlin time` | `03:21:34.332Z` |
| 10 | assistant | *(the fill row — `scheduledAt`)* | `03:21:47.536Z` |
| 11 | assistant | `Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.` | `03:21:49.197Z` |

`cinatra.agent_run_triggers` held **no row** for the run at that moment; the row that exists now was
written later by the person pressing the form's own button for the armed-trigger cell.

**Step by step (`89f947a2`)**

| seq | role | content | at |
|---|---|---|---|
| 1 | user | `set the offering company website to "https://example.test" and the call to action to "Book a 20-minute demo", and leave the sender name as it is` | `03:38:55.870Z` |
| 2 | assistant | *(the fill row — two fields, the third deliberately not touched)* | `03:39:10.878Z` |
| 3 | assistant | `Placed in the fields on your screen. Nothing was submitted — press the button when you are ready.` | `03:39:12.731Z` |
| 4 | user | `set the sender name to "Rita Owner" and send it` — **carrying `campaign-brief.txt`**, digest `576038005379a871f562e47022857a40c30371a389a38d872d0accc9a4816d11` | `03:40:27.025Z` |
| 5 | assistant | *(the fill row — `{"senderName":"Rita Owner"}`)* | `03:41:21.384Z` |
| 6 | assistant | `Submitted.` | `03:41:27.197Z` |

The attachment is on the PERSON'S own row, in `content_json.attachments`, and the step advanced —
which is the clause. The window draws no chip for it; that is observation D in the README, with the
code fact.

**The review page (`baa08154`)**

| reading | gate before → after | dispositions | repairs | decision bar before → after |
|---|---|---|---|---|
| `what changed in this draft?` | `pending` → `pending` (disposition NULL) | 0 → 0 | 0 → 0 | `["Comment","Reject","Approve"]` → `["Comment","Reject","Approve"]`, rationale `""` both times |
| `tighten the opening paragraph` | `pending` → `resolved` / `changes_requested` | 0 → 0 | 0 → **1** | `["Comment","Reject","Approve"]` → `[]` |

The repair row's `findings`, character for character:

```json
[{"id": "prompt-window", "message": "tighten the opening paragraph"}]
```

which EQUALS what the person typed.
