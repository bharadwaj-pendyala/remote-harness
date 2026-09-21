import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


class ChatError(Exception):
    pass


class ChatClient:
    def __init__(self, url, token):
        self.url = url.rstrip("/")
        self.token = token

    def _open(self, path, body=None):
        request = Request(
            f"{self.url}{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            return urlopen(request, timeout=210)
        except HTTPError as error:
            try:
                message = json.loads(error.read()).get("error", str(error))
            except (ValueError, UnicodeError):
                message = f"Chat service returned HTTP {error.code}"
            raise ChatError(message) from error
        except (URLError, TimeoutError) as error:
            raise ChatError("Cannot reach the chat service. Reconnect and refresh the conversation.") from error

    def _json(self, path, body=None):
        with self._open(path, body) as response:
            return json.load(response)

    def create(self):
        return self._json("/sessions", {})

    def get(self, session_id):
        return self._json(f"/sessions/{quote(session_id, safe='')}")

    def approve(self, session_id, revision, fast):
        return self._json(f"/sessions/{quote(session_id, safe='')}/approve", {"revision": revision, "fast": fast})

    def accept(self, session_id):
        return self._json(f"/sessions/{quote(session_id, safe='')}/accept", {})

    def message(self, session_id, message):
        complete = False
        try:
            with self._open(f"/sessions/{quote(session_id, safe='')}/messages", {"message": message}) as response:
                for line in response:
                    event = json.loads(line)
                    if event["type"] == "text":
                        yield event["text"]
                    elif event["type"] == "error":
                        raise ChatError(event["error"])
                    elif event["type"] == "done":
                        complete = True
        except (OSError, ValueError) as error:
            raise ChatError("The reply was interrupted. Refresh to recover the saved conversation.") from error
        if not complete:
            raise ChatError("The reply disconnected. Refresh to recover the saved conversation.")
