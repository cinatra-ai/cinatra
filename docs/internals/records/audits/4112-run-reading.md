# cinatra#4112 — run reading

This file records the readings for the first two criteria of #4112, on a development install and on a preview
installation: which account owns the Twenty CRM connection once the first administrator exists, and whether the list
picker reads the CRM's contact lists.

## Item 1: the development-boot reading

The first criterion of #4112 was read on one fresh development boot, on 2026-11-04. The database readings were reads
only; the product steps were one sign-in and one dispatched run, whose setup screens and trigger form were answered. The
database was read before anyone signed in, and the Connectors page and the list picker were then read through the
running product.

Heads. The boot ran the pull request's head `ad2fd68c769c0aed78ee08ef38b57a820dbc9a08`. Its code is the commit
`855796180371ff2c5b944da4b35a04229155b018`, one commit on main `7809657c29f0255e594c3af8f3ecdb9f14a18e11`; the commits
after it change only this file. The working tree had no changed file. The Twenty connector was pinned at `d8f3451f38b6`
and the Email Outreach Agent at `92874fdd00de`. An earlier reading of this item, taken on 2026-10-27 at the head
`dbfab842bc64f8cd3b46eadc48c244e8dbe264f7`, before the change of this pull request, also read REACHED; this section
replaces it with the reading at the final code head.

Boot and second start. The boot's first bring-up reported OK at 21:14:04Z and the second bring-up started at
21:14:44Z. The application server started at 21:18:48Z and the relay on the application port at 21:21:10Z, both after
the second bring-up started, and the application log holds one start line and no keep line, so the reading is of the
second start. The bring-ups name the boot a development copy. The application's health route answered 200, the agent
registry's health read answered 200 with 30 agents loaded and 0 failed, the sign-in page answered 200, and the run
table held 0 rows before the reading. On the second start the first administrator's adoption line appeared once, the
connect lines twice, the ok line once, and the warn, skip, no-administrator, Nango, mint and custom-fields lines 0
times. The log also holds three docker lines; the hook's own lines read ok.

Database readings, before any sign-in, all taken at 21:27:30Z:

| reading | what was read | counts and answers |
|---|---|---|
| D1 | the Twenty connector's install row | 1 row, version 0.1.7, active: yes |
| D2 | the `twenty-workspace` row | 1 row, scope workspace, enabled: yes, connection id present: yes, organisation id present: no |
| D3 | the `externalMcp` identity row | 1 row, 1 live; its connection id equals D2's: yes; organisation present: yes |
| D4 | the owner of D3's identity | 4 users, 1 human administrator; the owner is the earliest human administrator: yes |
| D4b | that administrator's memberships | 1 membership; D3's organisation is that first membership: yes |
| D5 | the grant on D3's identity | 1 row, run-execute visibility `workspace`: yes |

D2's organisation id is absent, as a workspace-scoped row expects. D3 carries the organisation.

Product readings, after the sign-in landed on the home page at 21:27:33Z. The sign-in was to the product; the reading's
steps include no sign-in to Twenty.

- U1: the sidebar link opened the Connectors page, the Twenty card was drawn (1) and it carried the connected mark (1).
- U2: one Email Outreach Agent run was dispatched from the Agents page. Its three setup screens were answered from their
  live labels. The trigger form drew with the immediate row already checked, and only its Continue was pressed. The list
  step then drew 4 option cards, 0 "No lists yet" cards and 0 load-failure toasts. The run was read at 21:29:40Z parked at
  that step, pending approval, not completed.

The U2 name match is a stated result of this reading, read from Twenty's own database: Twenty held 1 workspace, 5
person views and 4 people lists. Each of the 4 list names begins exactly one card and each card was matched once, so
the 4 cards are the 4 lists, none is missing and none is extra. The list this reading names for the check (the U2 list)
is one of the 4. The match was checked against Twenty's lists and reads met.

Result. D1, D2, D3, D4, D4b, D5, U1 and U2 were all reached on this one boot, so item 1 of #4112 reads REACHED at the
heads above. This section covers item 1 only. Item 2 (a preview installation) is read in the next section, and neither
section is the tests of item 3.

## Item 2: the preview-installation reading

The second criterion of #4112 was read on one fresh preview installation, on 2026-11-04, run in production mode with
the preview install profile. As for item 1, the database readings were reads only; the product
steps were one sign-in and one dispatched run, whose setup screens and trigger form were answered. The database was read
before anyone signed in, and the Connectors page and the list picker were then read through the running product.

Heads. The installation was built from the head the pull request had then,
`855796180371ff2c5b944da4b35a04229155b018`, one commit on main `7809657c29f0255e594c3af8f3ecdb9f14a18e11`; the image
carried that head as its label and the working tree had no changed file. The pull request's head has since moved to the
commits that add this record, which change no other file. The Twenty connector was pinned at `d8f3451f38b6` and the
Email Outreach Agent at `92874fdd00de`; both locks held.

Boot and second start. The first bring-up reported OK at 13:16:51Z, and the second bring-up started at 13:17:15Z and was
admitted at 13:17:25Z. The container that held the application
was created at 13:23:06Z, after the second bring-up was admitted, so its log holds the second start only and the reading
is of the second start. The runtime mode was production, the install profile preview and the Node environment
production. The health route answered 200 and the run table held 0 rows before the reading. On the second start the
preview branch's policy line (connector hooks only) appeared once, the first administrator's adoption line once, the
connect line once and the ok line once; the warn, skip, no-administrator, Nango, mint and custom-fields lines appeared
0 times, and no fixture account was set up. The log also holds three docker lines; the hook's own lines read ok.

The attach. The Twenty key was handed to the installation and none was minted (the handed line once, the minted line 0
times), and the attach resolved: the line `[dev-attach:twenty] not resolved: <word>` appeared 0 times, and each of its
failure words 0 times. From inside the installation, Twenty's health route and Nango's answered 200.

Database readings, before any sign-in, all taken at 13:54:37Z:

| reading | what was read | counts and answers |
|---|---|---|
| D1 | the Twenty connector's install row | 1 row, version 0.1.7, active: yes |
| D2 | the `twenty-workspace` row | 1 row, scope workspace, enabled: yes, connection id present: yes, organisation id present: no |
| D3 | the `externalMcp` identity row | 1 row, 1 live; its connection id equals D2's: yes; organisation present: yes |
| D4 | the owner of D3's identity | 4 users, 1 human administrator; the owner is the earliest human administrator: yes |
| D4b | that administrator's memberships | 1 membership; D3's organisation is that first membership: yes |
| D5 | the grant on D3's identity | 1 row, run-execute visibility `workspace`: yes |

D2's organisation id is absent, as a workspace-scoped row expects. D3 carries the organisation.

Product readings, after the sign-in landed on the home page at 13:54:39Z. The sign-in was to the product; the reading's
steps include no sign-in to Twenty.

- U1: the sidebar link opened the Connectors page, the Twenty card was drawn (1) and it carried the connected mark (1).
- U2: one Email Outreach Agent run was dispatched from the Agents page. Its three setup screens were answered from their
  live labels. The trigger form drew with the immediate row already checked, and only its Continue was pressed. The list
  step then drew 4 option cards, 0 "No lists yet" cards and 0 load-failure toasts. The run was read at 13:55:22Z parked at
  that step, pending approval, not completed.

The U2 name match is a stated result of this reading, taken at 13:55:32Z from Twenty's own database twelve seconds after
the cards' names were read: Twenty held 1 workspace, 5 person views and 4 people lists. Each of the 4 list names begins
exactly one card and each card was matched once, so the 4 cards are the 4 lists, none is missing and none is extra. The
list this reading names for the check (the U2 list) is one of the 4. The match does not depend on order: a read of
Twenty at 13:53:28Z showed all 5 person views at position 0, so their order is a tie. The match was checked against
Twenty's lists and reads met.

Result. D1, D2, D3, D4, D4b, D5, U1 and U2 were all reached on this one preview installation, so item 2 of #4112 reads
REACHED at the heads above. This section is not the tests of item 3.
