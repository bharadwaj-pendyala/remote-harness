import json
import os
import subprocess
from pathlib import Path

import streamlit as st

HARNESS_HOME = Path(__file__).resolve().parent.parent
RUNS_DIR = Path(os.environ.get("RUNS_DIR", HARNESS_HOME / "runs"))
RECORD_REPO = os.environ.get("RECORD_REPO", "")
MARKER = "<!-- run.json -->"

STATE_LABELS = {
    "clarifying": ("Waiting on you", "orange"),
    "clarified": ("Waiting on you", "orange"),
    "prepared": ("Building", "grey"),
    "implemented": ("Building", "grey"),
    "check-failed": ("Repairing", "grey"),
    "repairing": ("Repairing", "grey"),
    "checked": ("Building", "grey"),
    "recorded": ("Building", "grey"),
    "review-failed": ("Repairing", "grey"),
    "reviewed": ("Building", "grey"),
    "published": ("Ready to review", "green"),
    "stopped": ("Stopped", "red"),
}


def gh(*args):
    return subprocess.run(
        ["gh", *args], capture_output=True, text=True, check=True
    ).stdout.strip()


def harness(script, *args):
    env = {**os.environ, "RECORD_REPO": RECORD_REPO, "RUNS_DIR": str(RUNS_DIR)}
    return subprocess.run(
        ["node", str(HARNESS_HOME / "harness" / script), *args],
        cwd=HARNESS_HOME, env=env, capture_output=True, text=True, check=True,
    ).stdout.strip()


def dispatch(workflow, **inputs):
    args = ["workflow", "run", workflow, "--repo", RECORD_REPO]
    for key, value in inputs.items():
        args += ["-f", f"{key}={value}"]
    gh(*args)


def parse_record(body):
    if MARKER not in body:
        return None
    block = body.split(MARKER, 1)[1]
    start, end = block.find("```json"), block.rfind("```")
    if start < 0 or end <= start:
        return None
    return json.loads(block[start + len("```json"):end])


@st.cache_data(ttl=5)
def load_runs():
    issues = json.loads(
        gh("issue", "list", "--repo", RECORD_REPO, "--label", "harness-run",
           "--state", "all", "--limit", "30", "--json", "number,title,body")
    )
    runs = []
    for issue in issues:
        record = parse_record(issue["body"])
        runs.append(record or {
            "id": f"run-{issue['number']}",
            "request": issue["title"],
            "state": "clarifying",
            "history": [],
        })
    return runs


st.set_page_config(page_title="Ask for a change", page_icon="✳️", layout="centered")

if not RECORD_REPO:
    st.error("Set RECORD_REPO to the harness repository, as owner/repo.")
    st.stop()

runs = load_runs()
by_id = {run["id"]: run for run in runs}

with st.sidebar:
    st.subheader("Your requests")
    if st.button("New request", use_container_width=True):
        st.session_state.pop("run_id", None)
    for run in runs:
        label, colour = STATE_LABELS.get(run["state"], (run["state"], "grey"))
        if st.button(f":{colour}[{label}] · {run['request'][:38]}",
                     key=run["id"], use_container_width=True):
            st.session_state["run_id"] = run["id"]

run_id = st.session_state.get("run_id")

if not run_id:
    st.title("What would you like changed?")
    request = st.text_area("Describe it the way you would to a colleague.", height=120)
    if st.button("Send", type="primary", disabled=not request.strip()):
        new_id = harness("record.mjs", "open", request.strip())
        dispatch("clarify.yml", run_id=new_id, request=request.strip())
        st.session_state["run_id"] = new_id
        load_runs.clear()
        st.rerun()
    st.stop()

run = by_id.get(run_id, {"state": "clarifying", "request": "", "history": []})
label, colour = STATE_LABELS.get(run["state"], (run["state"], "grey"))

st.title(run["request"])
st.markdown(f":{colour}[**{label}**]")

if st.button("Refresh"):
    load_runs.clear()
    st.rerun()

questions = run.get("questions")
spec = run.get("spec")

if run["state"] == "clarifying" and not questions:
    st.info("Reading the application to work out what to ask you.")

elif run["state"] == "clarifying" and questions:
    st.subheader("A few questions before anything is built")
    for question in questions:
        st.markdown(f"**{question['ask']}**")
        st.caption(question["why"])
    reply = st.text_area("Answer in your own words.", height=120)
    if st.button("Send answers", type="primary", disabled=not reply.strip()):
        dispatch("execute.yml", run_id=run_id, mode="answer", reply=reply.strip())
        load_runs.clear()
        st.rerun()

elif run["state"] == "clarified":
    st.subheader("Here is what will be built")
    st.markdown(spec["summary"])
    for line in spec["acceptance"]:
        st.markdown(f"- {line}")
    st.caption("Unchanged: " + "; ".join(spec["unchanged"]))
    if st.button("That is right, build it", type="primary"):
        dispatch("execute.yml", run_id=run_id, mode="execute")
        load_runs.clear()
        st.rerun()

elif run["state"] == "published":
    st.subheader("Ready for you to look at")
    st.markdown(f"The recording and the change are on the pull request: {run['pr']}")
    if run.get("accepted"):
        st.success("You accepted this. An engineer owns the merge.")
    elif st.button("This is the behavior I wanted", type="primary"):
        harness("record.mjs", "pull", run_id)
        harness("run.mjs", "accept", run_id)
        harness("record.mjs", "push", run_id)
        load_runs.clear()
        st.rerun()

elif run["state"] == "stopped":
    st.error(run.get("reason", "The run stopped."))
    st.caption("Nothing was opened for review. The evidence is on the run record.")

else:
    st.info("Building and checking the change.")

with st.expander("Run record"):
    st.caption(f"{RECORD_REPO}#{run_id.removeprefix('run-')}")
    st.json(run, expanded=False)
