#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RECORD_REPO:?set RECORD_REPO to the harness repository, as owner/repo}"
exec streamlit run ui/app.py
