# Remote harness

A stakeholder asks about an application, discusses a change, and approves an
implementation spec. A persistent Claude Agent SDK conversation handles those
turns. GitHub Actions starts only after approval, then implements, checks,
records, reviews, and opens a draft pull request. An engineer owns the merge.

## Run the chat locally

Use Node 22 or later, Python 3.12, Git, and a standalone clone of the application.
The application clone must have a GitHub `origin` matching `APP_REPO`. Chat reads
the committed `HEAD`, ignoring dirty files. Update the clone before starting a
new conversation to investigate a newer base; existing conversations keep their
original commit.

```sh
npm ci
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt

export HARNESS_REPO=/absolute/path/to/todo-app
export APP_REPO=bharadwaj-pendyala/todo-app
export RECORD_REPO=bharadwaj-pendyala/remote-harness
export CHAT_DATA_DIR="$PWD/.chat-data"
export CHAT_ACCESS_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
# Set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) in your shell.
# Set HARNESS_GITHUB_TOKEN to a credential scoped as described below.
npm run chat
```

In another terminal with the same `CHAT_ACCESS_TOKEN`, run `./ui/run.sh`, then
open `http://127.0.0.1:8501`. The service defaults to `127.0.0.1:8787`.
`CHAT_SERVICE_URL` changes the backend URL. `RECORD_REPO` in the UI adds a link
to workflow activity.

For a container setup, export the same variables and run `docker compose up
--build`. The app clone is mounted read-only; chat state uses a named volume.
Use a standalone clone, not a linked worktree whose Git directory lives outside
the mount. The UI is published on loopback; the chat API stays inside the
Compose network. Run only one chat service instance per state directory.

The local setup is intended for a trusted demo audience. A shared service token
protects the backend, not individual stakeholder identities. Before exposing
Streamlit beyond loopback, add audience authentication and HTTPS at the hosting
boundary. A hosting provider has not been selected by this implementation.

## Credentials and execution setup

- The service needs Claude API or OAuth credentials. They are passed only to
  the SDK subprocess. When both exist, the API key takes precedence.
- `HARNESS_GITHUB_TOKEN` needs contents read/write, Actions write, and access to
  repository variables in the **harness** repository. It creates approved run
  records, checks `APP_REPO`, dispatches builds, reads results, and records
  behavior acceptance. It is never passed to the chat agent.
- Set the harness repository variable `APP_REPO` to the same application repo.
- The existing Actions secrets are `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN`, and `APP_REPO_TOKEN`. Only the publish job receives
  the app write token. Private applications also need checkout access configured
  for the worker; the demo application is public.
- The orphan `harness-state` branch must exist. `RECORD_BRANCH` can override the
  record branch. `HARNESS_REF` selects the workflow revision (default `main`).
  Put this change on that ref before approving a new SDK run. Repair uses the
  same harness ref as the original build.
- Publication requires `gh` 2.99 or newer for `pr create --attach`; the workflow
  installs a suitable version when needed. Repository rules and credential
  scope govern merge capability. The harness does not invoke merge.

Do not put credentials in app source, run records, transcripts, or committed
configuration. Keep `.chat-data` private: it contains conversations and SDK
session files. Preserve the volume across service restarts.

## Conversation and approval contract

The chat agent has four tools: list files, read a file, search source, and propose
a spec. Source comes from Git objects at the conversation's pinned commit;
symlinks cannot redirect a read to host files. No shell or edit tool is exposed.
The SDK receives no inherited GitHub credentials, user settings, or external MCP
configuration.

Messages stream through one long-lived SDK query. Idle SDK processes expire
after 15 minutes, while saved conversations remain. After a restart or idle
expiry, the service resumes the explicit SDK session ID. A turn has a three-minute
deadline; failures are visible, and a new message can resume the conversation.
A disconnected browser does not cancel a turn. Reopen its conversation URL to
recover the persisted reply.

A new message invalidates the previous draft. Approval names the current spec
revision and records a hash of it with the base commit and source findings.
Repeated approval returns the same run. A failed record write can be retried;
an uncertain dispatch response cannot be automatically retried because GitHub's
dispatch endpoint does not provide an idempotency key. Inspect Actions using
the run ID before any manual intervention. A conversation owns one build;
start a new conversation for the next change.

The workflow gate rejects a changed approved spec and skips an execute or repair
stage whose record has already advanced. Workflows for one run are serialized.
The existing worker still uses the Claude CLI to implement and review. It passes
the candidate and evidence to a separate publishing job. Terminal failures and
spent repair budgets are persisted as `stopped`. The UI returns the draft PR and
lets the stakeholder accept its behavior without merging it.

## Demo and verification

Use the [todo-app demo script](https://github.com/bharadwaj-pendyala/todo-app):
ask whether Important exists, ask for source evidence, request a persistent star
without filtering or sorting, refine the spec, then approve it. Verify reload,
completion, and unchanged ordering in the generated checks and recording.

```sh
npm test
npm run test:coverage
.venv/bin/python -m unittest discover -s test -p 'test_*.py'
```

Tests use fake SDK and GitHub boundaries, a real temporary Git repository, a
local HTTP server, and Streamlit's AppTest. They do not consume model credits or
dispatch workflows. A live rehearsal additionally requires Claude credentials,
the workflow revision on GitHub, the repository variable and secrets, and a
real approved run. Do not present a prepared PR as evidence of that new path.

Legacy workflow-driven intake remains at `ui/legacy_app.py`, `clarify.yml`, and
`execute.yml` mode `answer`. It requires `RECORD_REPO`, GitHub CLI credentials,
and the existing workflow setup. Direct stage commands remain in
`harness/run.mjs`; install the Node dependencies before using them.

The app's `harness.yml` documents the script contract. The worker currently
calls those paths directly; loading arbitrary repository adapters is future work.

SDK references: [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
[session persistence](https://code.claude.com/docs/en/agent-sdk/sessions), and
[custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools).
