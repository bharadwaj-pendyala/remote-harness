import json
import os
import subprocess
from pathlib import Path

import streamlit as st

HARNESS_HOME = Path(__file__).resolve().parent.parent
RUNS_DIR = Path(os.environ.get("RUNS_DIR", HARNESS_HOME / "runs"))
REPO = Path(os.environ.get("HARNESS_REPO", "")).expanduser()

STATE_LABELS = {
    "clarifying": ("Waiting on you", "orange"),
    "clarified": ("Ready to run", "blue"),
    "prepared": ("Running", "grey"),
    "implemented": ("Running", "grey"),
    "checked": ("Running", "grey"),
    "recorded": ("Ready to review", "green"),
    "published": ("Draft PR open", "green"),
    "stopped": ("Stopped", "red"),
}


def load_runs():
    records = []
    for path in sorted(RUNS_DIR.glob("*/run.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        records.append(json.loads(path.read_text()))
    return records


def load_run(run_id):
    return json.loads((RUNS_DIR / run_id / "run.json").read_text())


def harness(*args, log):
    command = ["node", str(HARNESS_HOME / "harness" / "run.mjs"), *args]
    env = {**os.environ, "HARNESS_REPO": str(REPO), "RUNS_DIR": str(RUNS_DIR)}
    lines = []

    process = subprocess.Popen(
        command, cwd=HARNESS_HOME, env=env, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1,
    )
    for line in process.stdout:
        lines.append(line.rstrip())
        log.code("\n".join(lines[-18:]), language=None)
    process.wait()
    return process.returncode


def git(*args):
    return subprocess.run(
        ["git", "-C", str(REPO), *args], capture_output=True, text=True
    ).stdout


st.set_page_config(page_title="Remote harness", page_icon="🛠", layout="wide")

if not REPO.exists():
    st.error("Set HARNESS_REPO to the application repository before starting the app.")
    st.stop()

with st.sidebar:
    st.subheader("Runs")
    st.caption(f"repository: {REPO.name}")
    runs = load_runs()
    if st.button("New request", use_container_width=True):
        st.session_state.pop("run_id", None)
    for record in runs:
        label, colour = STATE_LABELS.get(record["state"], (record["state"], "grey"))
        if st.button(
            f":{colour}[{label}] · {record['request'][:38]}",
            key=record["id"],
            use_container_width=True,
        ):
            st.session_state["run_id"] = record["id"]

run_id = st.session_state.get("run_id")

if not run_id:
    st.title("Describe the change you need")
    st.caption("Plain language. An engineer set the boundaries for this repository already.")
    request = st.text_area("Request", placeholder="Let me mark important tasks and focus on those first", height=110)
    if st.button("Send", type="primary", disabled=not request.strip()):
        log = st.empty()
        with st.spinner("Reading the repository and working out what to ask you"):
            harness("clarify", request.strip(), log=log)
        newest = load_runs()
        if newest:
            st.session_state["run_id"] = newest[0]["id"]
            st.rerun()
    st.stop()

run = load_run(run_id)
label, colour = STATE_LABELS.get(run["state"], (run["state"], "grey"))

st.title(run["request"])
st.markdown(f":{colour}[**{label}**] &nbsp; `{run['id']}` &nbsp; from `{run['baseCommit'][:7]}`")

if run["state"] == "clarifying":
    st.subheader("A few questions first")
    st.caption("Only the ones whose answers change what gets built.")
    answers = []
    with st.form("answers"):
        for question in run["questions"]:
            st.markdown(f"**{question['ask']}**")
            st.caption(question["why"])
            answers.append(st.text_input("Answer", key=question["id"], label_visibility="collapsed"))
        submitted = st.form_submit_button("Agree the task", type="primary")
    if submitted and all(a.strip() for a in answers):
        log = st.empty()
        with st.spinner("Turning your answers into an agreed task"):
            harness("answer", run_id, *[a.strip() for a in answers], log=log)
        st.rerun()

elif run["state"] == "clarified":
    spec = run["spec"]
    st.subheader(spec["summary"])
    left, right = st.columns(2)
    with left:
        st.markdown("**This will be true when it is done**")
        for item in spec["acceptance"]:
            st.markdown(f"- {item}")
    with right:
        st.markdown("**This must not change**")
        for item in spec["unchanged"]:
            st.markdown(f"- {item}")
    st.info(f"**Check**  {spec['check']}")
    if st.button("Start the run", type="primary"):
        log = st.empty()
        with st.spinner("Running remotely. Implementing, checking, recording."):
            harness("execute", run_id, log=log)
        st.rerun()

elif run["state"] == "stopped":
    st.error(run.get("reason", "the run stopped"))
    checks = run.get("artifacts", {}).get("checks")
    if checks and Path(checks).exists():
        st.code(Path(checks).read_text()[-3000:], language=None)

else:
    video = run.get("artifacts", {}).get("video")
    if video and Path(video).exists():
        st.subheader("What it does now")
        st.video(str(video))

    st.subheader("Does this do what you asked?")
    accepted, changes = st.columns(2)
    if accepted.button("Yes, this is the behavior I wanted", type="primary", use_container_width=True):
        harness("accept", run_id, log=st.empty())
        st.rerun()
    if changes.button("Not quite, I want to change something", use_container_width=True):
        st.info("Describe what is different and the next run starts from here.")

    if run.get("accepted"):
        st.success("You accepted this behavior. An engineer reviews the code and owns the merge.")

    if run.get("pr"):
        st.markdown(f"The engineering review is on GitHub: {run['pr']}")
    else:
        st.caption("No draft pull request yet: the repository has no remote configured.")
