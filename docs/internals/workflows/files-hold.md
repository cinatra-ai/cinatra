# Files hold

A pull request can pass its checks and its verification and then wait for review for hours. If another pull request that changes some of the same files merges in that time, the waiting pull request's verification no longer holds for the tree its own merge would make: it has to be brought up to date and verified again. The label `holds-files` and the commit status `files-hold` make the shared files visible, and let the waiting pull request hold them until it is reviewed.

The workflow is `.github/workflows/files-hold.yml`; the script is `scripts/ci/files-hold.mjs`.

## The label

Put `holds-files` on a pull request whose verification is complete at its head and that waits for review. That pull request then holds its files, for at most 24 hours (see "How long a hold lasts" below). The label must exist in the repository before it can be put on a pull request.

## The status

Every open pull request, a draft too, gets the status `files-hold` on its head.

| Status | Description | Meaning |
| --- | --- | --- |
| failure | `Held by #N: a, b, c and K more` | The pull request changes files that the labelled pull request #N changes too. The first three shared paths are named, in order, then how many more there are. |
| success | `No labelled pull request holds files now.` | No open pull request holds files: none carries the label, or every label is more than 24 hours old and this pull request shares no file with those pull requests. |
| success | `Changes no file that a labelled pull request holds.` | Labelled pull requests exist; this one shares no file with them. |
| success | `Labelled holds-files: holds its files against the other open pull requests.` | This pull request carries the label and holds its files. |
| success | `Hold of #N expired after 24 hours: a, b, c and K more` | The labelled pull request #N changes files that this one changes too, but its label is more than 24 hours old: its hold expired, and it holds nothing now. The shared paths are named as in `Held by #N`. |
| success | `Its holds-files label is more than 24 hours old: the hold expired, it holds nothing now.` | This pull request carries the label, but the label was set more than 24 hours ago. If a pull request with a newer label holds some of its files, its status is `Held by #N` instead. |
| failure | `Its file list could not be read in full: ...` | See "When a list cannot be read" below. |
| failure | `Holds nothing: ...` | A labelled pull request whose own file list, or the time its label was set, cannot be read. |

The files are each pull request's own changed files as the platform lists them. A renamed file counts under its old and its new name. No file is left out.

Between two labelled pull requests that share a file, the one labelled first holds its files against the other; with the same time, the lower number holds. The later one's status fails and names the first. It still holds its own files against pull requests without the label.

A closed or merged pull request holds nothing and gets no status. A pull request from a fork is evaluated like any other, and no code of a pull request runs.

## What a push does

A push to a labelled pull request ends its hold: its verification was made at the head it had. The first job of the workflow takes the label off and says so in one comment on the pull request. Put the label back once the new head is verified. A label put on after the push stays.

A pull request that is closed and reopened keeps its label. If its head moved while it was closed, take the label off.

## How long a hold lasts

The maintainer decided on 2026-10-08: "A files hold lasts at most 24 hours. After that, other pull requests that change the same files may be pictured and merged, and the pull request that held them is brought up to date afterwards."

- A hold lasts at most 24 hours from the time its label was set. Exactly 24 hours still holds; any time after that, the hold has expired.
- An expired holder holds nothing. The pull requests that share its files are no longer held by it: their status succeeds, and the description names the expired hold and the shared paths, so nobody is surprised. The expired holder's own status says that its hold expired. A pull request with a newer label holds its files against the expired holder as against any other pull request.
- The label stays on. The workflow does not take it off and writes no comment.
- What the author of the expired holder does: bring the pull request up to date with the files that changed, verify it again, then take the label off and put it back. The label put back starts a new 24 hours. A push to a labelled pull request already takes the label off (see "What a push does").
- The time of the label is the time of its latest `labeled` event, so a label taken off and put back counts from the time it was put back.

## The override

The override is a maintainer's: take the label off the holding pull request, or review and merge it first. Either event runs the workflow again, and every status follows.

## When a list cannot be read

The platform lists at most 3000 files of one pull request. A file list is complete only when every page was read and the rows read equal the pull request's own count of changed files.

- A file list that cannot be read in full, because the pull request has more files than the platform lists or because a read failed, fails the status of the pull request it concerns, and the description says why.
- A labelled pull request whose own file list, or the time its label was set, cannot be read holds nothing, and its own status says so.
- While no open pull request carries the label, no file list is read: nothing is held, and every status succeeds.
- If the open pull requests cannot be listed, the run fails and writes no status.

## How it runs

- The workflow runs on `pull_request_target` for the events opened, reopened, synchronize, ready_for_review, labeled, unlabeled and closed, by hand (`workflow_dispatch`), and every hour (`schedule`).
- Every hour, at minute 17, a scheduled run applies an expiry without a pull request event. Hourly keeps the time between an expiry and its run under an hour; minute 17 keeps off the top of the hour, when scheduled runs are delayed most. The platform may delay a scheduled run under load, or drop it; any pull request event applies an expiry too. A scheduled run evaluates no pull request of its own: it takes in the heads whose status no longer fits, as below. When other holders remain, the holders changed and it evaluates every open pull request; when the expired holder was the last, it takes in the statuses held by it, its own status and the statuses that name no hold. The first job is skipped on a scheduled run.
- It has two jobs. On a push, the first job takes the label off a pull request that carried it from before the push, and writes the one comment; it runs in a group of its own for each pull request and is never cancelled. The evaluation runs after it, so that it reads the labels as that job left them, one evaluation at a time for the whole repository.
- An event that changes no holder evaluates its own pull request alone, against the holders, and writes that pull request's status only: a pull request opened, reopened, pushed or made ready for review without the label, or a label event of another label. A pull request without the label that closes needs nothing.
- An event that changes the holders evaluates every open pull request: the label set or taken off, or a labelled pull request closed, merged, reopened or pushed. A run by hand evaluates every open pull request too.
- Whatever the event, the evaluation also takes in each head whose status is missing or no longer fits the holders: a head without a status; a status held by a pull request that holds nothing now; a status set while no pull request held files, when one does; a status that disagrees with the label on its pull request; a status that says its pull request holds, when it holds nothing now; a status set while a pull request held files, when none does. When a holder's status was set against other holders, it evaluates every open pull request. The link of each status names the holders it was set against, as a short fingerprint. So an evaluation that a newer event replaced before it ran leaves nothing behind.
- Just before it writes, the evaluation lists the open pull requests again. A pull request pushed while it was evaluated is not written: the run for the push writes it.
- On `pull_request_target` the workflow file comes from the default branch, and both jobs check out the default branch. A scheduled run runs on the default branch too, at its last commit. They never check out or run a pull request's code: the script reads the platform's listings only. A change to the workflow takes effect once it is on the default branch.
- The permissions are the least each job needs: the first job `contents: read` and `pull-requests: write` (to take the label off and write the comment); the evaluation `contents: read`, `pull-requests: read` and `statuses: write`.
- The label time is read from the pull request's issue events: the time of its latest `labeled` event for `holds-files`. The evaluation reads the clock once and judges every hold at that one time.
- A status is written only when it changes, and a holder's status also when the holders change. The platform keeps at most 1000 statuses per commit and context.
- A label taken off with the job's token starts no new workflow run, so the evaluation after that job sets the statuses itself.
- The log lists each holder, each hold that expired with the time of its label, each status it sets, the number of requests the run made, and the token's remaining budget.

To see what the evaluation would do without writing anything:

```sh
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/name GITHUB_EVENT_NAME=pull_request_target \
  GITHUB_EVENT_PATH=event.json node scripts/ci/files-hold.mjs evaluate --dry-run
```

## Requests

The counts below are for 50 open pull requests, as on 2026-09-29, and are pinned by the script's tests.

| Evaluation | No labelled pull request (as on 2026-09-29) | Two labelled pull requests |
| --- | --- | --- |
| One pull request, against the holders | 2 REST and 1 GraphQL request, and at most 1 status written | 10 REST and 1 GraphQL request, and at most 1 status written |
| Every open pull request | 2 REST and 1 GraphQL request, and each status that changed | 104 REST and 1 GraphQL request, and up to 50 statuses |
| A scheduled run, every status fitting | 1 REST and 1 GraphQL request, and no status written | 7 REST and 1 GraphQL request, and no status written |

A head that an evaluation takes in because its status is missing or no longer fits adds its own reads and its write. Each labelled pull request adds 3 reads to either kind: its record, its file list and its label time. While one exists, each other pull request evaluated adds 2: its record and its file list. A pull request with more than 100 changed files adds a read for each further 100. The first job makes no request on a push to a pull request without the label, and 2 reads and 2 writes (the label and the comment) on a push to a labelled one. A scheduled run reads the open pull requests and, for each labelled pull request, its record, its file list and its label time; when a hold expired, it then evaluates the heads that the expiry changed, as above.

## Limits

- **API budget.** The job's token may make 1,000 REST requests per hour per repository, shared with every other workflow that uses it (15,000 for an Enterprise Cloud account). An hour of 21 pull request events that each change no holder, with two labelled pull requests, makes about 210 REST requests; each change of the holders adds about 104. The hourly scheduled run adds 1 REST request an hour while no pull request carries the label, and 7 with two labelled pull requests (24 runs a day); a run in which a hold expires adds the reads and writes of the heads it evaluates, up to those of every open pull request.
- **Events from forks.** A `pull_request_target` workflow runs without approval, so the author of any pull request, one from a fork too, starts an evaluation by opening, pushing to, closing or reopening it.
- **A change of the holders rewrites the holders' statuses.** Each holder's status names the holders it was set against, so it is written again whenever they change; other statuses are written only when their text changes.

## Before the status is made required

Making `files-hold` a required status is a setting of the repository, not part of this workflow. Check these first.

**The platform's policy for this event.** The page "Securely using pull_request_target" (docs.github.com/en/actions/reference/security/securely-using-pull_request_target), section "Default policy for pull_request_target", says:

> For public repositories that do not already have an applicable Actions event policy, GitHub adds a default policy that blocks workflows triggered by `pull_request_target`.

> On November 2, 2026, GitHub will enforce the default policy for affected repositories that were using the default `pull_request_target` policy before general availability.

The same page says that the default policy "Currently runs in **evaluate** mode" and, for a workflow that must keep the event: "create or update an applicable Actions event policy that explicitly allows `pull_request_target`." The page "Controlling who can execute GitHub Actions workflows" (docs.github.com/en/actions/how-tos/administer/control-workflow-execution) carries the note: "GitHub has added a default policy that will block the `pull_request_target` event in public repositories. This policy will be enforced on November 2, 2026."

**No policy exists yet.** On 2026-09-29 the REST API listed no Actions policy for this repository and none for its organization: `GET /repos/{owner}/{repo}/actions/policies` and `GET /orgs/{org}/actions/policies` both answered `"total_count": 0`. This workflow is the only one in the repository that runs on `pull_request_target`.

**The policy that allows this one workflow.** A repository Actions policy (Settings, then under Actions, Policies; or `POST /repos/{owner}/{repo}/actions/policies`) with enforcement `active`, the workflow condition `workflow_path` including `.github/workflows/files-hold.yml` ("You can scope policies to specific workflow paths or required workflows"), and an event rule, `restrict_action_events`, whose `allowed_events` are `pull_request_target` and `workflow_dispatch` ("Event rules control which events are permitted").

**How to see that the workflow still runs.** Look at the age of the newest `files-hold` status. After a push to any open pull request, its head carries a `files-hold` status within minutes; the pull request's checks list shows it with its time, and `GET /repos/{owner}/{repo}/commits/{sha}/statuses` lists it newest first with its `created_at`. A newest status older than the latest push means that the workflow no longer runs. A run the policy blocks fails with an error that names the event, and the repository's Policy insights page lists the runs that were blocked, or that would be blocked while the default policy only evaluates.

**The rest.**

- A required status must have succeeded in the repository within the last seven days before it can be selected.
- The status is set with the job's token. Choose the app that sets it as its expected source (the setting lists the apps that set it recently), or any source.
- A merge queue's candidates do not carry this status: it is set on pull request heads only. A queue that requires it would wait for it.
