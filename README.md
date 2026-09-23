# Remote harness

A stakeholder describes a change in plain language. An agent asks the questions
that would change what gets built, implements it on a machine nobody configured,
runs the checks, records the behavior, and opens a draft pull request. An
engineer owns the merge.

## The shape

Everything talks to the run record. Nothing talks to anything else.

- **Request interface** `ui/app.py`. Captures the request, shows the questions,
  takes the reply, shows state in the requester's language, hands back the pull
  request. It never runs the agent.
- **Run record** `runs/<id>.json` on the orphan `harness-state` branch of this
  repository. Written with `createCommitOnBranch(expectedHeadOid)`, so a stale
  write is rejected rather than silently merged. Every transition is a commit,
  so the log is the history. It is never checked out into the tree the agent
  edits.
- **Worker** a GitHub Actions job. Created for one stage, destroyed after. Holds
  no credential that can write to the application repository.
- **Publisher** a separate job that holds the only write token. Pushes the
  branch and opens the draft pull request.
- **Router** a job that wakes on each transition, reads the record, and decides
  what happens next. A failed check with budget left becomes a repair. A spent
  budget stops the run with the evidence retained.

The coordinator is not a server. It wakes, decides, dispatches, and exits. It is
durable because the record and the trigger outlive it.

## Stages

    clarify   questions, and what intake found in the repository
    answer    the reply becomes an agreed spec
    execute   branch, implement, check, record, commit
    repair    one attempt against the failing check
    publish   push, draft pull request, video attached

## Running a stage by hand

    export HARNESS_REPO=../todo-app
    node harness/run.mjs clarify "let me mark important tasks"
    node harness/run.mjs answer <run-id> "a separate view, and it should stick"
    node harness/run.mjs execute <run-id>
    node harness/run.mjs publish <run-id>

## What the repository under change must provide

A `harness.yml` naming setup, start, ready, checks, record, and artifacts. The
keys never change. Only the commands do.

## Configuration

Repository variable:

- `APP_REPO` the application repository, as `owner/repo`

Repository secrets:

- `ANTHROPIC_API_KEY` for the agent
- `APP_REPO_TOKEN` a token that can push a branch and open a pull request on the
  application repository. Only the publish job sees it.

Requires `gh` 2.99.0 or newer for inline video on the pull request.
