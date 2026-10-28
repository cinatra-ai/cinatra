# cinatra#3773 — run reading

This file records the keyboard reading for #3773: on the blog pipeline's idea step, the arrow keys move the focus and the choice between the ideas of the radio group, as a radio group does everywhere else in the product.

## The reading

Walk 2026-10-28T08:00:36Z to 08:07:58Z on a keyless development boot, head 8b747b678eb3. Pipeline run 78bb6753-2a1a-4143-a87d-c5bf88a35966 drew the idea group 'Select one blog idea to draft' with five radios in the order items 5, 4, 3, 2, 1 (R3 REACHED). Keys through the kit's pressKey at 08:07:34Z to 08:07:48Z: ArrowDown from the first radio checked the second; ArrowUp went back to the first; a second ArrowUp wrapped to the last; Home checked the first; End checked the last; Home checked the first again. Each press moved the focus to the expected radio, and after each press that radio read checked and exactly one radio read checked. Before the first press only the focused first radio was read (unchecked) and no checked count was taken, so the first press is not read as moving an earlier choice; each later press moved the choice from the radio the press before it had left checked. 3773-KEYS: MET.

## The six key presses

The radios were drawn in the order items 5, 4, 3, 2, 1, so the first radio is item 5 and the last is item 1. The first press started with focus on the first radio, which read unchecked.

| Press | Key | Before the press | Checked after (expected) | Radios checked after | Met |
|---|---|---|---|---|---|
| k1 | ArrowDown | item 5 (focus only) | item 4 (item 4) | 1 | met |
| k2 | ArrowUp | item 4 | item 5 (item 5) | 1 | met |
| k3 | ArrowUp | item 5 | item 1 (item 1) | 1 | met |
| k4 | Home | item 1 | item 5 (item 5) | 1 | met |
| k5 | End | item 5 | item 1 (item 1) | 1 | met |
| k6 | Home | item 1 | item 5 (item 5) | 1 | met |

3773-KEYS: MET
