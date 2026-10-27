# cinatra#4112 — run reading

This file records the development-install reading for the first criterion of #4112: which account owns the Twenty CRM
connection once the first administrator exists, and whether the list picker reads the CRM's contact lists.

## Item 1: the development-boot reading

The first criterion of #4112 was read on one fresh development boot made by the install flow with a public lane address,
on 2026-10-27. The reading changed no row except the one run it dispatched: the database was read before anyone signed
in, and the Connectors page and the list picker were then read through the running product.

Heads. The boot ran the head of the pull request that carries this file, `dbfab842bc64f8cd3b46eadc48c244e8dbe264f7`,
which stands on main `e1ecb5379de0d4ee2a4a4cfa1ed323253327b379`. The Twenty connector was pinned at `d8f3451f38b6` and the
Email Outreach Agent at `dddb203f6100`; both locks held.

Boot and second start. The boot's first bring-up finished at 22:57:42Z and the second bring-up was admitted at 22:58:39Z.
The application process that served the reading started at 23:04:48Z, after the second bring-up, so the reading is of the
second start. The start line appeared once and the keep line did not appear. The runtime mode was development, the health
route answered 200 with 30 agents loaded and 0 failed, the working tree had no changed file, and the run table held 0
rows before the reading. On the second start the first administrator's adoption line appeared once, the connect lines
twice, the ok line once, and the warn, skip, no-administrator, Nango and mint lines 0 times. The log also holds three
lines about a container composition not running; they are no gate, and the hook's own lines read ok.

Database readings, before any sign-in, all taken at 23:11:13Z:

| reading | what was read | counts and answers |
|---|---|---|
| D1 | the Twenty connector's install row | 1 row, version 0.1.7, active: yes |
| D2 | the `twenty-workspace` row | 1 row, scope workspace, enabled: yes, connection id present: yes, organisation id present: no |
| D3 | the `externalMcp` identity row | 1 row, 1 live; its connection id equals D2's: yes; organisation present: yes |
| D4 | the owner of D3's identity | 4 users, 1 human administrator; the owner is the earliest human administrator: yes |
| D4b | that administrator's memberships | 1 membership; D3's organisation is that first membership: yes |
| D5 | the grant on D3's identity | 1 row, run-execute visibility `workspace`: yes |

D2's organisation id is absent, as a workspace-scoped row expects. D3 carries the organisation.

Product readings, after the sign-in landed on the home page:

- U1: the sidebar link opened the Connectors page, the Twenty card was drawn (1) and it carried the connected mark (1).
- U2: one Email Outreach Agent run was dispatched from the Agents page. Its three setup screens were answered from their
  live labels. The trigger form drew with the immediate row already checked, and only its Continue was pressed. The list
  step then drew 4 option cards, 0 "No lists yet" cards and 0 load-failure toasts. The run stayed parked at that step,
  pending approval, and no run was completed.

The U2 name match is a stated result of this reading, taken at 23:13:29Z from Twenty's own database nine seconds after
the cards were read: Twenty held 1 workspace, 5 person views and 4 people lists. Each of the 4 list names begins exactly
one card and each card was matched once, so the 4 cards are the 4 lists, none is missing and none is extra. The list
this reading names for the check (the U2 list) is one of the 4. The match does not depend on order: all 5 person views
stand at position 0 in Twenty, so their order is a tie. The reading driver's own U2 line reads `reached:false`. That is
by design: the driver writes U2 as not reached until the match is taken, because the match is the scout's step and not
the driver's. The match above was checked against Twenty's lists and reads met.

Result. D1, D2, D3, D4, D4b, D5, U1 and U2 were all reached on this one boot, so item 1 of #4112 reads REACHED at the
heads above. This record covers item 1 only. It does not read item 2 (a preview installation) and it is not the tests of
item 3, so it does not close #4112.
