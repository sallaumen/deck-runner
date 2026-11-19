#!/usr/bin/env python3
"""Install/update the Linux user service without losing a queue or an active job."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

SRC = Path(__file__).resolve().parents[1]
HOME = Path.home()
ROOT = HOME / ".local/share/deck-runner"
APP = ROOT / "app"
UNITS = HOME / ".config/systemd/user"
sys.path.insert(0, str(SRC))
from settings import PORT


def ctl(*args, check=True):
    return subprocess.run(
        ["systemctl", "--user", *args], check=check, stdout=subprocess.PIPE, text=True
    )


def old(action):
    return json.loads(
        subprocess.check_output([sys.executable, APP / "server.py", action])
    )


def install():
    if os.getuid() != 1000 or sys.version_info < (3, 11):
        raise SystemExit(
            "Use a conta de desktop de UID 1000 e Python 3.11 ou superior."
        )
    subprocess.run(["podman", "info"], check=True, stdout=subprocess.DEVNULL)
    if (SRC / "server.py").resolve() == (APP / "server.py").resolve():
        raise SystemExit(
            "Execute o instalador a partir de um checkout separado da instalação."
        )
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    files = {
        APP / f: SRC / f
        for f in [
            "activity.py",
            "live.py",
            "storage.py",
            "profiles.py",
            "settings.py",
            "run-project.sh",
            "open-panel.sh",
            "display.py",
            "server.py",
        ]
    }
    files.update(
        {
            APP / "web" / f: SRC / "web" / f
            for f in ["icon.svg", "dashboard.css", "dashboard.js", "controller.js", "activity.js", "limits.js", "storage.js", "motion.js", "motion.css", "station.css", "gantry.webp", "cargo.webp", "pilot.png", "dashboard.html"]
        }
    )
    files.update(
        {
            UNITS / f: SRC / f
            for f in [
                "deck-runner.service",
                "deck-runner-display.service",
                "decktests.slice",
            ]
        }
    )
    for dest in [
        ".local/share/applications/deck-runner.desktop",
        ".config/autostart/deck-runner.desktop",
    ]:
        files[HOME / dest] = SRC / "deck-runner.desktop"
    files[HOME / ".local/share/icons/hicolor/scalable/apps/deck-runner.svg"] = (
        SRC / "web/icon.svg"
    )
    already = (
        ctl("is-active", "--quiet", "deck-runner.service", check=False).returncode == 0
    )
    paused = old("status")["paused"] if already else False
    with tempfile.TemporaryDirectory(dir=ROOT, prefix="install-") as scratch:
        backup = {}
        for dest, source in files.items():
            if not source.is_file():
                raise FileNotFoundError(source)
            if dest.exists():
                backup[dest] = Path(scratch) / str(len(backup))
                shutil.copy2(dest, backup[dest])
        if already:
            old("pause")
        touched = []
        try:
            if already:
                while any(j["state"] == "running" for j in old("status")["jobs"]):
                    time.sleep(2)
            for dest, source in files.items():
                dest.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as temp:
                    new = Path(temp.name)
                shutil.copy2(source, new)
                new.replace(dest)
                touched.append(dest)
            ctl("daemon-reload")
            ctl("enable", "deck-runner.service")
            ctl("restart", "deck-runner.service")
            for attempt in range(30):
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{PORT}/api/status", timeout=2
                    ) as reply:
                        s = json.load(reply)
                    if (
                        s.get("instance")
                        and s["alive"]
                        and s["instance"] == old("status")["instance"]
                    ):
                        break
                except OSError:
                    pass
                time.sleep(1)
            else:
                raise RuntimeError("O novo executor não respondeu.")
        except BaseException:
            for dest in reversed(touched):
                if dest in backup:
                    shutil.copy2(backup[dest], dest)
                else:
                    dest.unlink(missing_ok=True)
            ctl("daemon-reload")
            if already:
                ctl("restart", "deck-runner.service")
            raise
        finally:
            if already and not paused:
                old("resume")
    print(
        f"Deck Runner ativo em http://127.0.0.1:{PORT}/. O painel abre ao entrar no desktop."
    )
    if (
        ctl("is-active", "--quiet", "graphical-session.target", check=False).returncode
        == 0
    ):
        ctl("restart", "--no-block", "deck-runner-display.service")


if __name__ == "__main__":
    install()
