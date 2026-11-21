# cinatra#3089 - run reading

This file records the development-install run reading for items 2 and 4 of #3089: whether the send step's email fan-out
writes one ledgered body revision per recipient, read from the run's database rows.

## Acceptance 7: the recorded run reading

The development-install run reading of acceptance 7 writes its result here: the run id, the recipient count, the revision list and the retry result, read from one fresh development boot of this branch. Until that reading is done, this section holds no result.

## Acceptance 7: the second run reading

The second development-install run reading of acceptance 7 was done on 2026-11-16 from one fresh development boot of this branch, on a main that carries the campaign id fix of the send confirmation (main a736e93f). The section above is the first placeholder of this record; this section holds the result. The mail detail pane (item 1) is graded separately: the grade receipt is https://github.com/cinatra-ai/cinatra/pull/4463#issuecomment-6905198519.

The reading did not reach the send. It found the send-step defect that is now filed as cinatra-ai/email-outreach-agent#74, together with cinatra-ai/cinatra#3745. Item 7 is not met by this reading, and #3089 stays open.

### The four owed facts

- Run id: 1b06ae24-69db-47a9-bd38-4de6a7acc726. The run read status completed at 2026-11-16T05:22:43Z, read again at 05:25:05Z.
- Recipient count: 2. The run holds two recipient records that carry the campaign id: one keyed by its contact with an email key, one keyed by its contact without an email key. The recipients review showed the same two rows.
- Revision list: empty. For this run there are 0 fan-out materialization rows, 0 representation revisions and 0 artifact-produced events. There are also 0 sent-email objects and 0 body objects.
- Retry result: not read. The retry reading needs a first fan-out, and there was none. Before: 0 fan-out rows, 0 revisions, 0 produced events, retry control count 0 (05:25:05Z). After: the same 0, 0, 0 (05:25:06Z). The second send-tool call was not made.

### What the page showed

The send confirmation gate was answered and the campaign id was set. Continue was pressed once, and the run completed within about 30 seconds. Neither ending was drawn: the text "the emails could not be sent" read 0 times and "were drafted and sent" read 0 times.

### Cause read

The embedded send step of the outreach pack carries its own instructions, and they name no send tool. If the model called the send tool anyway, the tool boundary holds a call that sends on a person's behalf on any run frame until a recorded decision exists (cinatra-ai/cinatra#3745). Either way the fan-out is not reached from this run. This reading did not tell which of the two happened.

### NOT READ

NOT READ on this reading: one ledgered body revision per message, the live_generator origin of each body, one artifact-produced event per message, the retry that writes nothing, the refusal of a send that cannot go (item 4), and the bodies reached by recipient identity. Items 2, 3 and 4 stay covered by the tests named in #3089 until a run reaches the fan-out, and item 7 stays open.
