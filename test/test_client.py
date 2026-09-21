import io
import json
import unittest
from unittest.mock import patch

from ui.client import ChatClient, ChatError


class ChatClientTest(unittest.TestCase):
    def test_stream_yields_text_and_requires_completion(self):
        payload = b'{"type":"heartbeat"}\n{"type":"text","text":"Hello"}\n{"type":"done","session":{}}\n'
        client = ChatClient("http://example.test", "test-token")
        with patch("ui.client.urlopen", return_value=io.BytesIO(payload)) as transport:
            self.assertEqual(list(client.message("session", "Question")), ["Hello"])
            request = transport.call_args.args[0]
            self.assertEqual(json.loads(request.data), {"message": "Question"})
            self.assertEqual(request.headers["Authorization"], "Bearer test-token")

    def test_stream_failure_is_not_a_successful_response(self):
        client = ChatClient("http://example.test", "test-token")
        for payload in [b'{"type":"error","error":"Provider unavailable"}\n', b'{"type":"text","text":"Partial"}\n']:
            with self.subTest(payload=payload), patch("ui.client.urlopen", return_value=io.BytesIO(payload)):
                with self.assertRaises(ChatError):
                    list(client.message("session", "Question"))

    def test_approval_sends_only_the_reviewed_revision(self):
        client = ChatClient("http://example.test", "test-token")
        with patch("ui.client.urlopen", return_value=io.BytesIO(b'{"approval":{}}')) as transport:
            client.approve("session", 4, False)
            request = transport.call_args.args[0]
            self.assertTrue(request.full_url.endswith("/approve"))
            self.assertEqual(json.loads(request.data), {"revision": 4, "fast": False})


if __name__ == "__main__":
    unittest.main()
