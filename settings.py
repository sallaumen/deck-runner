"""Connection defaults shared by the client, service and installers."""

from pathlib import Path
import os
import re

PORT = 4040
CONFIG = Path.home() / ".config" / "deck-runner"


def valid_host(value):
    if not re.fullmatch(r"(?:[a-zA-Z0-9_][\w.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*", value):
        raise ValueError(
            "Use a hostname, IPv4 address or SSH alias, optionally prefixed with user@."
        )
    return value


def host():
    saved = CONFIG / "host"
    value = os.environ.get("DECK_RUNNER_HOST") or (
        saved.read_text().strip() if saved.exists() else "deck@steamdeck.local"
    )
    return valid_host(value)


def ssh_options():
    return [
        "-o",
        "ControlPath=%d/.config/deck-runner/link-%C",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=6",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
    ]
