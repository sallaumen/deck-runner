#!/usr/bin/env python3
"""Keep the dedicated Plasma dashboard attached to its systemd user service."""

import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
import urllib.request

from settings import PORT

URL = f"http://127.0.0.1:{PORT}/?screen=1"
PROFILE = Path.home() / ".var/app/com.google.Chrome/config/deck-runner-display"
PROFILE_ARG = f"--user-data-dir={PROFILE}"


def is_display(args):
    return (
        args[:1] == [b"/app/extra/chrome"]
        and os.fsencode(PROFILE_ARG) in args
        and any(arg.startswith(b"--app=http://127.0.0.1:") for arg in args)
        and not any(arg.startswith(b"--type=") for arg in args)
    )


def browser_handle():
    # Flatpak can put the real window in a separate app scope. A launcher PID
    # cannot tell systemd whether that window is still alive.
    for path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            if not is_display(path.read_bytes().split(b"\0")):
                continue
            fd = os.pidfd_open(int(path.parent.name))
            try:
                if is_display(path.read_bytes().split(b"\0")):
                    return fd
            except OSError:
                pass
            os.close(fd)
        except OSError:
            continue
    return None


def wait_handle(fd, timeout=None):
    try:
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        return bool(poll.poll(timeout))
    finally:
        os.close(fd)


def stop():
    fd = browser_handle()
    if fd is not None:
        try:
            signal.pidfd_send_signal(fd, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if not wait_handle(fd, 10000):
            raise RuntimeError("The dedicated browser is still closing")


def show():
    while True:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{PORT}/api/status", timeout=3
            ):
                break
        except OSError:
            time.sleep(2)
    fd = browser_handle()
    if fd is None:
        proc = subprocess.Popen(
            [
                "flatpak",
                "run",
                "com.google.Chrome",
                PROFILE_ARG,
                "--class=deck-runner",
                "--name=deck-runner",
                "--ozone-platform=x11",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-session-crashed-bubble",
                f"--app={URL}",
                "--start-fullscreen",
            ]
        )
        for _ in range(100):
            fd = browser_handle()
            if fd is not None:
                break
            if proc.poll() not in (None, 0):
                raise RuntimeError(f"Flatpak exited with status {proc.returncode}")
            time.sleep(0.2)
        else:
            raise RuntimeError("The dedicated browser did not open")
    wait_handle(fd)


if __name__ == "__main__":
    if sys.argv[1:] == ["stop"]:
        stop()
    else:
        show()
