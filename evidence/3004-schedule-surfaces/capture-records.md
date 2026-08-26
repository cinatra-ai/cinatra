# Capture records — #3004 schedule surfaces

Stack built from `7f85012544114aac97de069b9eb9ca0bc2f80074`. Signed in as the run's owner
(`Ops Operator Two`, `operator2@example.com`) through the sign-in form. Every frame is a
full-window capture, viewport 1440x900 at device scale 2 (2880x1800 pixels), taken in the
application's own light and dark themes. All captures on 2026-08-26 (UTC).

| file | cell | theme | surface | run | captured (UTC) | pixels | sha256 |
|---|---|---|---|---|---|---|---|
| `A1__agent-page-live-recurring__light.png` | A1 | light | `/agents/cinatra-ai/planner-agent/1fd2dc65-5ae1-44d7-a6d6-6846342209d7/trigger` | X | 12:25:51 | 2880x1800 | `f33337af19ed705b147d8e24eec5fff349ce9e5f87318f3140d2e22ad2672e62` |
| `A1__agent-page-live-recurring__dark.png` | A1 | dark | same | X | 12:26:17 | 2880x1800 | `00fe8e23f1910322f0c65526574a5d5b7bff8e5e0716554d117302dc4fe1fb18` |
| `A2__agent-page-fired-one-off__light.png` | A2 | light | `/agents/cinatra-ai/planner-agent/efcd07d3-5c2f-4db4-965e-4bd31d446040/trigger` | Y | 12:30:27 | 2880x1800 | `014a18783905beabf3e6182594e7ebedb87fec8842994a2c0506217f284f5a0a` |
| `A2__agent-page-fired-one-off__dark.png` | A2 | dark | same | Y | 12:30:38 | 2880x1800 | `f8e12dbc140c27ed063b2028ab227bc14fb7947397f8701df008c947abd31847` |
| `A3__agent-page-recurring-cancelled-after-a-fire__light.png` | A3 | light | `/agents/cinatra-ai/planner-agent/1fd2dc65-5ae1-44d7-a6d6-6846342209d7/trigger` | X | 12:34:39 | 2880x1800 | `d82e2f4e1a51e876808559ecaad9e3a377a061da04d8de50acee7a5a3b5faa1d` |
| `A3__agent-page-recurring-cancelled-after-a-fire__dark.png` | A3 | dark | same | X | 12:34:54 | 2880x1800 | `6c2cc399580f93a3f12d2ab3168cefe197cc3a063a7d893a70b7d03bef787f89` |
| `A3x__cancel-confirm-strip__light.png` | A3 (supporting) | light | same | X | 12:34:11 | 2880x1800 | `5596cad73a37432dbd9c531867ffde2180b1c1fef141fe77761eeb47852d6b74` |
| `R1__run-page-after-continue__light.png` | R1 | light | `/agents/cinatra-ai/planner-agent/0836760a-6ca6-4d39-a1b7-2bd3c5bdfbb0` | W | 12:37:41 | 2880x1800 | `5e5fd51d95bc79d78140f1465c12f6ddbc6046e968a5ae541ef2741e2b3eb3f3` |
| `R1__run-page-after-continue__dark.png` | R1 | dark | same | W | 12:37:46 | 2880x1800 | `d5133db1b873ec845ecc4db465405593be53a31e338f23fb5b94d62d7511c8e9` |
| `R2__run-page-schedule-step-armed-on-agent-page__light.png` | R2 | light | `/agents/cinatra-ai/planner-agent/1fd2dc65-5ae1-44d7-a6d6-6846342209d7` | X | 12:26:07 | 2880x1800 | `b88d2b80d5be2998beac5dd72867c2db7804c39a03617365c5b6d98ccc56845f` |
| `R2__run-page-schedule-step-armed-on-agent-page__dark.png` | R2 | dark | same | X | 12:26:32 | 2880x1800 | `593867b107f6f974ede1dca2fcdc780e04e1ff4a081d53c40835229ac71a0210` |
| `T1__agent-page-wording-and-composer__light.png` | T1 | light | `/agents/cinatra-ai/planner-agent/5402c970-6548-411f-91f1-dbfd781434e2/trigger` | Z | 12:40:52 | 2880x1800 | `aff075b9c15e959e790a94b6bf00458eedc3e202975d91f9193978eef8edd233` |
| `T1__agent-page-wording-and-composer__dark.png` | T1 | dark | same | Z | 12:41:07 | 2880x1800 | `91060a019ba6368f205ea7a5256f6f0608d677e82b971df45c19ed1d56fae2ae` |

## Database stamps at readback (2026-08-26 12:44:47Z)

`cinatra.agent_run_triggers`

```
run_id                               | type      | scheduled_at | cron        | timezone      | enabled | released_at   | last_fired_at | stopped_at
1fd2dc65-5ae1-44d7-a6d6-6846342209d7 | recurring |              | 25 14 * * * | Europe/Berlin | f       |               | 12:25:00.276Z | 12:34:28.138Z
efcd07d3-5c2f-4db4-965e-4bd31d446040 | scheduled | 12:30:00Z    |             | Europe/Berlin | t       | 12:30:00.095Z |               |
5402c970-6548-411f-91f1-dbfd781434e2 | scheduled | 13:10:00Z    |             | Europe/Berlin | t       |               |               |
d71075c3-930e-463d-aba4-61608d95ec6e | immediate |              |             | Europe/Berlin | t       | 12:25:00.187Z |               |
0836760a-6ca6-4d39-a1b7-2bd3c5bdfbb0 | scheduled | 15:40:00Z    |             | Europe/Berlin | t       |               |               |
```

`cinatra.agent_runs`

```
1fd2dc65-5ae1-44d7-a6d6-6846342209d7 | armed     | Agent Planner (5) | created 12:10:20.101Z
efcd07d3-5c2f-4db4-965e-4bd31d446040 | completed | Agent Planner (6) | created 12:16:45.109Z
5402c970-6548-411f-91f1-dbfd781434e2 | armed     | Agent Planner (7) | created 12:19:44.581Z
d71075c3-930e-463d-aba4-61608d95ec6e | completed |                   | created 12:25:00.240Z
0836760a-6ca6-4d39-a1b7-2bd3c5bdfbb0 | armed     | Agent Planner (8) | created 12:37:10.356Z
```

`cinatra.usage_events`

```
12:25:46.048Z | llm | openai | gpt-5.5-2026-04-23 | generate | in 36414 | out 589 | requested openai -> effective openai
12:30:16.963Z | llm | openai | gpt-5.5-2026-04-23 | generate | in 36414 | out 461 | requested openai -> effective openai
```

No row in any of these tables was written by hand. `CINATRA_TEST_LLM_PROVIDER` was unset for the
whole round; the provider key is the organization's own, as the ledger's
`requested -> effective` pair shows.

## Guards taken through the screen only

```
A1-editable (attempted on the recurring rows) : the card draws its hour and minute as
    comboboxes, not native selects — the guard did not complete on this surface and was
    taken on R1 instead. Nothing was changed on run X by the attempt.
R1-editable   : Run at 2026-08-26T17:40 -> 2026-08-26T17:00 (local, Europe/Berlin)
                Save changes ["disabled"] -> ["ENABLED"]   (never saved; the row still reads 15:40:00Z)
cancel-confirm-strip : "Stop this recurring schedule? No further runs will start from it. The
                runs it has already started are not affected, and this run is not changed. The
                schedule stays here, and you will not be able to change it afterwards.
                Keep schedule | Cancel schedule"
                contains "Cancel scheduled trigger?" : false
A2-read-only  : pressed Run right after setup / Schedule for later / Recurring, then tried to
                fill Run at -> the field refused the value
                enabled controls 0 -> 0, floor 0, rows unchanged
A3-no-rearm   : pressed Run right after setup / Schedule for later / Recurring
                enabled controls 0 -> 0, floor 0, Continue 0
```
