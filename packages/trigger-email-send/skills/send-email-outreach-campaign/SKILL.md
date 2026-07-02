---
name: send-email-outreach-campaign
description: Use when the task is to prepare, test, schedule, or send a Cinatra Email Outreach campaign, especially the Send emails step, including send readiness, test emails, launch timing, and delivery behavior through connected inboxes.
metadata:
  match_when:
    - agent_id: "@cinatra-ai/email-delivery-agent"
    - agent_id: "@cinatra-ai/email-outreach-agent"
---

# Send Email Outreach Campaign

## Screen

This skill operates on screen `email_outreach.screen.send_emails`.

Entry-point tools on this screen:
- `email_outreach.send.test.start` — sends a test email to a specified recipient; returns an `AsyncOperationState`
- `email_outreach.send.initial.start` — triggers the real campaign send; returns an `AsyncOperationState`
- `email_outreach.send.initial.status` — polls send progress
- `email_outreach.send.initial.cancel` — cancels an in-progress send
- `email_outreach.launch_schedule.update` — updates the initial send schedule or autopilot setting

Always call `email_outreach.send.test.start` before `email_outreach.send.initial.start` to verify copy, links, sender identity, and formatting.

## What This Step Covers

- send readiness review
- test email sending
- initial campaign send
- understanding follow-up delivery behavior

## Workflow

1. Open the `Send emails` step.
2. Review whether the campaign is ready to send.
3. Send a test email first when verifying copy, links, sender identity, or formatting.
4. Trigger the real send only with the explicit send action.
5. Confirm any schedule or autopilot behavior shown in the flow.

## Important Sending Behavior

- Initial emails are sent only from the explicit send action on `email_outreach.screen.send_emails`.
- Saving draft edits or schedules on earlier screens does not send emails.
- Follow-up delivery is handled afterward according to the configured timing logic.
- In development mode, Cinatra may redirect outgoing email to an override recipient.
