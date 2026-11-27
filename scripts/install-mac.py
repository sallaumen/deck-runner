#!/usr/bin/env python3
"""Verify the Deck, install the Mac client and keep its SSH tunnel connected at login."""

import argparse
import json
import os
from pathlib import Path
import plistlib
import shlex
import socket
import subprocess
import sys
import time
import urllib.request

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
from settings import CONFIG, PORT, ssh_options, valid_host

LABEL = "io.github.deck-runner.tunnel"
HOME = Path.home()


def tunnel(host, legacy):
    forwards = ["-L", f"127.0.0.1:{PORT}:127.0.0.1:{PORT}"]
    if legacy:
        forwards += ["-L", f"127.0.0.1:{legacy}:127.0.0.1:{legacy}"]
    return {
        "Label": LABEL,
        "ProgramArguments": [
            "/usr/bin/ssh",
            "-NT",
            *ssh_options(),
            "-o",
            "ControlMaster=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            *forwards,
            host,
        ],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ProcessType": "Background",
        "StandardErrorPath": str(HOME / "Library/Logs/deck-runner/tunnel.log"),
    }


def install(host, legacy):
    if sys.platform != "darwin" or sys.version_info < (3, 11):
        raise SystemExit("Requer macOS e Python 3.11+.")
    remote = json.loads(
        subprocess.check_output(
            [
                "ssh",
                *ssh_options(),
                host,
                "python3 .local/share/deck-runner/app/server.py status",
            ]
        )
    )
    if not remote.get("instance") or not remote["alive"]:
        raise SystemExit("Instale e inicie o executor no Deck primeiro.")
    pl = HOME / f"Library/LaunchAgents/{LABEL}.plist"
    domain = f"gui/{os.getuid()}"
    pl.parent.mkdir(parents=True, exist_ok=True)
    (HOME / "Library/Logs/deck-runner").mkdir(parents=True, exist_ok=True)
    CONFIG.mkdir(parents=True, exist_ok=True, mode=0o700)
    CONFIG.chmod(0o700)
    previous = pl.read_bytes() if pl.exists() else None
    loaded = (
        subprocess.run(
            ["launchctl", "print", domain + "/" + LABEL], capture_output=True
        ).returncode
        == 0
    )
    if loaded:
        subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], check=True)
    try:
        for port in [PORT] + ([legacy] if legacy else []):
            for attempt in range(12):
                with socket.socket() as probe:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    try:
                        probe.bind(("127.0.0.1", port))
                        break
                    except OSError as exc:
                        if not loaded or attempt == 11:
                            raise RuntimeError(
                                f"A porta local {port} está ocupada."
                            ) from exc
                time.sleep(0.2)
        pl.write_bytes(plistlib.dumps(tunnel(host, legacy)))
        subprocess.run(["launchctl", "bootstrap", domain, str(pl)], check=True)
        for _ in range(24):
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT}/api/status", timeout=2
                ) as reply:
                    local = json.load(reply)
                if local.get("instance") == remote["instance"]:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError(
                f"Porta {PORT} indisponível ou túnel desconectado. Veja ~/Library/Logs/deck-runner/tunnel.log."
            )
    except BaseException:
        subprocess.run(
            ["launchctl", "bootout", domain + "/" + LABEL], capture_output=True
        )
        if previous is None:
            pl.unlink(missing_ok=True)
        else:
            pl.write_bytes(previous)
        if loaded:
            subprocess.run(["launchctl", "bootstrap", domain, str(pl)], check=True)
        raise
    CONFIG.mkdir(parents=True, exist_ok=True)
    (CONFIG / "host").write_text(host + "\n")
    cli = HOME / ".local/bin/deck-runner"
    cli.parent.mkdir(parents=True, exist_ok=True)
    cli.write_text(
        "#!/bin/sh\nexec "
        + shlex.join([sys.executable, str(SOURCE / "client.py")])
        + ' "$@"\n'
    )
    cli.chmod(0o755)
    desktop = HOME / "Desktop"
    desktop.mkdir(exist_ok=True)
    (desktop / "Testes no Deck.webloc").write_bytes(
        plistlib.dumps({"URL": f"http://127.0.0.1:{PORT}/"})
    )
    app = HOME / "Applications/Adicionar projeto ao Deck.app"
    app.parent.mkdir(exist_ok=True)
    subprocess.run(
        ["osacompile", "-o", str(app), str(SOURCE / "add-project.applescript")],
        check=True,
    )
    link = desktop / app.name
    if not link.exists() and not link.is_symlink():
        link.symlink_to(app, target_is_directory=True)
    subprocess.run([str(cli), "doctor", "--station"], check=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("host", nargs="?", default="deck@steamdeck.local", type=valid_host)
    p.add_argument(
        "--legacy-port",
        type=int,
        help="Também encaminhar a porta antiga de uma instalação migrada",
    )
    args = p.parse_args()
    if args.legacy_port is not None and (
        not 1024 <= args.legacy_port <= 65535 or args.legacy_port == PORT
    ):
        p.error(
            "A porta anterior deve ser distinta da atual e estar entre 1024 e 65535."
        )
    install(args.host, args.legacy_port)
