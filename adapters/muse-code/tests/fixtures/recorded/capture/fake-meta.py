#!/usr/bin/env python3
"""Scripted stand-in for the Meta Responses endpoint, used only to capture muse fixtures.

`muse --base-url http://127.0.0.1:18777` sends `GET /muse-code/models` and streaming
`POST /responses` requests here. The lead agent (the request that offers `subagent_spawn`)
receives the next scripted function call per completed call in its input; spawned children
and background observers receive plain text. Usage is reported on every response so the
recorded logs carry real `model_completed` usage records.

Usage: SCRIPT=script.json python3 fake-meta.py
"""
import http.server
import itertools
import json
import os
import time

PORT = int(os.environ.get("PORT", "18777"))
SCRIPT_PATH = os.environ.get("SCRIPT", "script.json")
CHILD_MARKER = os.environ.get("CHILD_MARKER", "Count lines in README")
counter = itertools.count()


def sse(stream, event):
    stream.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
    stream.flush()


def nested_tool_names(request):
    names = []
    for tool in request.get("tools", []):
        names.append(tool.get("name"))
        names.extend(inner.get("name") for inner in tool.get("tools") or [])
    return names


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        body = b'{"object":"list","data":[{"id":"fake-model","object":"model"}]}'
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get("content-length", 0) or 0)))
        index = next(counter)
        with open(SCRIPT_PATH) as handle:
            script = json.load(handle)
        tools = nested_tool_names(request)
        completed_calls = sum(1 for item in request["input"] if item.get("type") == "function_call_output")
        first_user = next((json.dumps(item) for item in request["input"] if item.get("role") == "user"), "")
        is_child = CHILD_MARKER in first_user
        is_lead = "subagent_spawn" in tools and not is_child
        if is_lead and completed_calls < len(script):
            step = script[completed_calls]
            item = {
                "type": "function_call",
                "id": f"fc_{index}",
                "call_id": f"call_{index}",
                "name": step["name"],
                **({"namespace": step["ns"]} if step.get("ns") else {}),
                "arguments": json.dumps(step["args"]),
                "status": "completed",
            }
        else:
            text = "Done." if is_lead else ("child done: README has 1 line" if "bash" in tools else "no reminder")
            item = {
                "type": "message",
                "id": f"msg_{index}",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        usage = {
            "input_tokens": 1200 + index,
            "input_tokens_details": {"cached_tokens": 100},
            "output_tokens": 30,
            "output_tokens_details": {"reasoning_tokens": 5},
            "total_tokens": 1230 + index,
        }
        response = {
            "id": f"resp_{index}",
            "object": "response",
            "created_at": int(time.time()),
            "model": request.get("model"),
            "status": "in_progress",
            "output": [],
        }
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("connection", "close")
        self.end_headers()
        sse(self.wfile, {"type": "response.created", "sequence_number": 0, "response": response})
        sse(self.wfile, {"type": "response.output_item.added", "sequence_number": 1, "output_index": 0, "item": item})
        sse(self.wfile, {"type": "response.output_item.done", "sequence_number": 2, "output_index": 0, "item": item})
        done = dict(response, status="completed", output=[item], usage=usage)
        sse(self.wfile, {"type": "response.completed", "sequence_number": 3, "response": done})
        self.close_connection = True


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
