# harness-state

The run record. One file per run at `runs/<id>.json`.

Written only by the harness, with `createCommitOnBranch(expectedHeadOid)`, so a
stale write is rejected rather than silently merged. Every state transition is a
commit, so the log is the history.

Nothing here is ever checked out into the repository the agent edits.
