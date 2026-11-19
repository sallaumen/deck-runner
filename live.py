"""One database observer fans committed queue changes out to all open displays."""

import contextlib
import sqlite3
import threading


class Changes:
    def __init__(self):
        self.condition = threading.Condition()
        self.version = 0

    def observe(self, db, stop=None):
        stop = stop or threading.Event()
        while not stop.is_set():
            try:
                with contextlib.closing(db()) as c:
                    previous = None
                    while not stop.is_set():
                        # CLI submissions and the worker use separate processes.
                        # Heartbeats and RAM samples must not wake every dashboard.
                        state = tuple(
                            c.execute(
                                "SELECT id,state,cancel FROM jobs WHERE finished IS NULL ORDER BY id"
                            )
                        )
                        latest = c.execute(
                            "SELECT id,state FROM jobs WHERE finished IS NOT NULL ORDER BY finished DESC,id DESC LIMIT 1"
                        ).fetchone()
                        settings = tuple(
                            c.execute(
                                "SELECT key,value FROM settings WHERE key IN ('slots','paused') ORDER BY key"
                            )
                        )
                        snapshot = (state, latest, settings)
                        if snapshot != previous:
                            previous = snapshot
                            with self.condition:
                                self.version += 1
                                self.condition.notify_all()
                        stop.wait(0.6)
            except sqlite3.Error:
                stop.wait(2)

    def stream(self, handler):
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        version = -1
        try:
            while True:
                with self.condition:
                    self.condition.wait_for(lambda: version != self.version, timeout=12)
                    current = self.version
                frame = (
                    f"id: {current}\nevent: queue\ndata: {current}\n\n"
                    if current != version
                    else ": alive\n\n"
                )
                handler.wfile.write(frame.encode())
                handler.wfile.flush()
                version = current
        except (OSError, TimeoutError):
            pass
