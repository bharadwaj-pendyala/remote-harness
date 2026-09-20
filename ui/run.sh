#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export HARNESS_REPO="${HARNESS_REPO:-$HOME/Documents/Github/harness-demo}"
exec .venv/bin/streamlit run ui/app.py --server.port "${PORT:-8501}" --server.headless true
