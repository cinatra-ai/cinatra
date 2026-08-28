# The order of events, from the lane's own clock

All times UTC, on 2026-08-28. Every row is either a line the driver printed or a
row read back out of the round's own throwaway database.

| when | what |
| --- | --- |
| 03:50 | the lane's own database is created and the public schema applied |
| 04:00 | the dev boot answers pages but **every `/api/auth/*` route 404s**; a `.next` cache carried over from the previous round is removed and the server restarted — see the bring-up findings |
| 04:12 | the app answers `/api/auth/get-session` 200; the lane account signs up, is made an administrator, creates its organization and joins the organization the boot stamped every agent template with |
| 04:13 | the instance namespace is set through `/setup/name`; the public origin through `/configuration/development?tab=tunnel`; the model provider through `/setup/model`, which seals the connection itself |
| 04:13 | the three run packages are published to the instance's own registry and read back — `blog-draft-writer-agent@0.1.4`, `context-selection-agent@0.1.1`, `blog-post-artifact@0.1.4` |
| 04:14 | four organization-owned skill assignments are written through the shipped `upsertCustomSkillAssignment` — and the shipped reader resolves **none** of them |
| 04:34 | the widget's own hosted sign-in is refused `401 not_same_origin` on every attempt; the app's own request origin is measured and the origin pair is corrected — see the bring-up findings |
| 04:48 | the third-party application is served on its own origin; the connector instance is registered; the connect site is minted through the product's OWN `/connect/authorize` consent screen and redeemed at `POST /api/connect/token` (`200`, a `cnx_` credential) |
| 04:52 | the widget signs itself in and reaches its ACTIVE phase; the first turn is answered *"Cinatra tools are unavailable … not reachable"* — the public ingress is cold |
| 05:09 | with the ingress warmed the widget's own composer starts a run; it parks at the agent's own setup screen, and the widget draws `agent_hitl_screen` on `site_widget` |
| 05:14 | the four skill assignments are rewritten with the CANONICAL skill ids and the shipped reader resolves all four |
| 05:36 | a widget-started run parks at the recommendation moment for the first time: four chips, all three affordances on each |
| 06:03 | the chips are decided one at a time on their own controls — confirm, adjust + keep, skip, confirm — and the row settles IN PLACE |
| 06:14 | run `096e5a56…` starts; its row reaches `lifecycle_moment=schedule` with `lifecycle_card_ref=null` and the widget draws **no schedule card**; it is released on the app's own run page (disclosed) |
| 06:26 | 260 polled samples of the widget column while the run works: `[data-run-review-slot]` = **0** on every one |
| 06:39 | the run's artifact review gate is created — `53781825-e912-4aaa-8275-4337f90efe85`, `pending` |
| 07:07 | fifteen minutes of polling later the widget column still draws **no review card** |
| 07:35 | the third-party page is reloaded and the widget signs in again: still no review card, and the gate is still pending |
| 07:43 | the settled chip row IS still there after that reload, in both palettes |
| 07:43 | *"Approve the review for me."* typed into the widget's own box is answered **"This message is not allowed to operate that control. Nothing was done."** |
| 07:49 / 07:59 | a schedule stated in the widget's own conversation, twice, is answered **"Not available to you."** |
| 08:05 | *"Approve the review and then reject it as well."* is answered **"I can't both approve and reject the same review. Please choose approve or reject."** |
| 08:12 | run `01b55935…` — the run every INDEX RECORD in this round is taken from — starts from the widget's own composer and parks at the recommendation moment |
| 08:13 | the four filed cells: held light, held dark, settled light, settled dark |
| 08:14 | the third-party page is reloaded, the widget signs in again, and the settled row is photographed still there in both palettes |
