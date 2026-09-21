#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RECORD_REPO:?set RECORD_REPO to the harness repository, as owner/repo}"

streamlit=streamlit
[ -x .venv/bin/streamlit ] && streamlit=.venv/bin/streamlit

exec "$streamlit" run ui/app.py "$@"
