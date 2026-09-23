#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CHAT_ACCESS_TOKEN:?set CHAT_ACCESS_TOKEN to the chat service token}"

streamlit=streamlit
[ -x .venv/bin/streamlit ] && streamlit=.venv/bin/streamlit

exec "$streamlit" run ui/app.py --server.address 127.0.0.1 "$@"
