import os

import streamlit as st

from client import ChatClient, ChatError

st.set_page_config(page_title="Bharad Harness", page_icon="✳️", layout="centered")
st.title("Bharad Harness")
st.caption("Ask about the app. Discuss a change. Approve the spec when it is ready.")

token = os.environ.get("CHAT_ACCESS_TOKEN", "")
if not token:
    st.error("Set CHAT_ACCESS_TOKEN to the same token used by the chat service.")
    st.stop()

client = ChatClient(os.environ.get("CHAT_SERVICE_URL", "http://127.0.0.1:8787"), token)
session_id = st.query_params.get("conversation")
with st.sidebar:
    st.subheader("Conversation")
    st.caption("This URL reconnects to the saved conversation on this service.")
    if st.button("New conversation", use_container_width=True):
        st.query_params.clear()
        st.rerun()
    if st.button("Refresh", use_container_width=True):
        st.rerun()

try:
    session = client.get(session_id) if session_id else None
except ChatError as error:
    st.error(str(error))
    st.stop()

if session:
    st.caption(f"Source commit: {session['baseCommit'][:12]}")
    for message in session["messages"]:
        with st.chat_message(message["role"]):
            st.markdown(message["content"])
    if session.get("error"):
        st.error(session["error"])


@st.fragment(run_every="5s")
def show_progress(conversation):
    try:
        current = client.get(conversation)
        if current["busy"]:
            st.info("The agent is working. You can reconnect using this conversation URL.")
            return
        if not current.get("approval"):
            st.rerun()
        approval = current["approval"]
        run = current.get("run", {})
        st.subheader("Remote build")
        if current.get("statusError"):
            st.warning("The saved conversation is available, but build status could not be refreshed: " + current["statusError"])
        if approval["status"] == "uncertain":
            st.warning("The dispatch result is uncertain. Check GitHub Actions before any manual retry.")
        st.write(f"Run: `{approval['runId']}` · {run.get('state', approval['status'])}")
        record_repo = os.environ.get("RECORD_REPO", "")
        if record_repo:
            st.link_button("Workflow activity", f"https://github.com/{record_repo}/actions")
        if run.get("pr"):
            st.link_button("Review the draft PR and video", run["pr"], type="primary")
            st.caption("Review the behavior in the recording. An engineer owns code review and merge.")
            if run.get("accepted"):
                st.success("You accepted the behavior. An engineer owns the merge.")
            elif st.button("This is the behavior I wanted", key=f"accept-{conversation}"):
                client.accept(conversation)
                st.rerun()
        if run.get("reason"):
            st.error(run["reason"])
    except ChatError as error:
        st.error(str(error))


if session and (session["busy"] or session.get("approval")):
    show_progress(session_id)

if session and session.get("spec") and not session["busy"] and not session.get("approval"):
    spec = session["spec"]
    st.subheader(f"Spec revision {session['revision']}")
    st.markdown(f"**{spec['title']}**\n\n{spec['summary']}")
    for criterion in spec["acceptance"]:
        st.markdown(f"- {criterion}")
    st.caption("Unchanged: " + "; ".join(spec["unchanged"]))
    st.caption("Check: " + spec["check"])
    fast = st.checkbox("Fast recording", value=True, help="Keep the WebM recording without an additional H.264 encode.")
    if st.button(f"Approve revision {session['revision']} and build", type="primary"):
        try:
            client.approve(session_id, session["revision"], fast)
            st.rerun()
        except ChatError as error:
            st.error(str(error))

message = st.chat_input("Ask a question or describe a change", disabled=bool(session and (session["busy"] or session.get("approval"))))
if message:
    try:
        if not session:
            session = client.create()
            session_id = session["id"]
            st.query_params["conversation"] = session_id
        with st.chat_message("user"):
            st.markdown(message)
        with st.chat_message("assistant"):
            st.write_stream(client.message(session_id, message))
        st.rerun()
    except ChatError as error:
        st.error(str(error))
