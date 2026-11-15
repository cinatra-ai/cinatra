# Attribution-record correction — f225fb41 (user avatar accent)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `f225fb41272824b73b25e58be6fe34cf17d0a5cd`
("Draw user avatars as initials on a categorical accent in the shared UI and chat (#4435)").

## What was wrong
The squash landed with a gate-suite verification record, but its `Assisted-by`
record names only the agents named on the pull request's commits. Two independent
read-only reviewers whose findings changed the code are missing.

- The reviewer on the third `Assisted-by` line of the commit that adds this file:
  the findings of a pre-merge review of the change drove commit `3029fe1beb`, whose
  message describes the same cures (initials from the directory name, initials only
  from letters, one accent seed per branch). The review's run record names the model.
- The reviewer on the second `Assisted-by` line: a read-only self-check of the change
  reported a test gap, and the fold that followed it is, by the match of its content,
  commit `c9c6c30229` (four branches the first tests left out). This link rests on a
  coordination row that sends the finding to the fold and on that content match.
  No record names the commit.

Both commits reached this change through pull request 4335's reviewed range, which
pull request 4381 carried and pull request 4435 re-cut.

## The corrected truthful record for f225fb41

The corrected record names the building agents and the two reviewing agents.
The change itself is untouched. The commit that adds this file carries the
four corrected Assisted-by lines in its trailer block and `Correction-for: f225fb41272824b73b25e58be6fe34cf17d0a5cd`.

## What stays unconfirmed
The fourth `Assisted-by` line comes from the trailer of commit `4a914234fa`, pull
request 4083's only commit. No run record of that commit that was found states its
model, and nothing found contradicts the trailer. The line is kept as the trailer
states it and is unconfirmed.
