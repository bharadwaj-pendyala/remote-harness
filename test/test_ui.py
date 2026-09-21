import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from streamlit.testing.v1 import AppTest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ui"))
from client import ChatClient

APP_PATH = str(Path(__file__).resolve().parents[1] / "ui" / "app.py")


class ChatUITest(unittest.TestCase):
    def test_read_only_question_streams_without_exposing_an_approval(self):
        session = {"id": "session-test", "baseCommit": "a" * 40, "messages": [], "busy": False, "spec": None, "approval": None}
        with patch.dict(os.environ, {"CHAT_ACCESS_TOKEN": "test-token"}), \
             patch.object(ChatClient, "create", return_value=session), \
             patch.object(ChatClient, "get", return_value=session), \
             patch.object(ChatClient, "message", return_value=iter(["Only title and completion exist."])), \
             patch.object(ChatClient, "approve") as approve:
            app = AppTest.from_file(APP_PATH).run()
            self.assertEqual(len(app.exception), 0)
            app.chat_input[0].set_value("Is Important implemented?").run(timeout=15)
            self.assertEqual(len(app.exception), 0)
            self.assertEqual(app.query_params["conversation"], ["session-test"])
            approve.assert_not_called()

    def test_a_draft_shows_its_revision_and_approval_uses_that_revision(self):
        session = {"id": "session-test", "baseCommit": "a" * 40, "messages": [], "busy": False, "approval": None, "revision": 3,
                   "spec": {"title": "Add Important", "summary": "Persist a marker", "acceptance": ["Survives reload"], "unchanged": ["List order"], "check": "Reload the page"}}
        with patch.dict(os.environ, {"CHAT_ACCESS_TOKEN": "test-token"}), \
             patch.object(ChatClient, "get", return_value=session), \
             patch.object(ChatClient, "approve") as approve:
            app = AppTest.from_file(APP_PATH)
            app.query_params["conversation"] = "session-test"
            app.run()
            self.assertEqual(len(app.exception), 0)
            button = next(button for button in app.button if button.label == "Approve revision 3 and build")
            button.click().run()
            approve.assert_called_once_with("session-test", 3, True)


if __name__ == "__main__":
    unittest.main()
