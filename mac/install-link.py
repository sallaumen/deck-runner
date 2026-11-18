#!/usr/bin/env python3
"""Install the optional, per-user Steam Link reconnect helper."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time

NAME = "io.github.deck-runner.steam-link"
SOURCE = Path(__file__).with_name("DeckLink.swift")
HOME = Path.home()
APP = HOME / "Applications/Deck Link.app"
PLIST = HOME / f"Library/LaunchAgents/{NAME}.plist"
RECEIPT = HOME / ".config/deck-runner/link-build"
DOMAIN = f"gui/{os.getuid()}"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(app):
    contents = app / "Contents"
    binary = contents / "MacOS/DeckLink"
    binary.parent.mkdir(parents=True)
    subprocess.run(["xcrun", "swiftc", "-O", SOURCE, "-o", binary], check=True)
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": NAME, "CFBundleExecutable": "DeckLink",
        "CFBundleName": "Deck Link", "CFBundlePackageType": "APPL",
        "CFBundleVersion": "1", "LSUIElement": True,
        "NSAccessibilityUsageDescription": "Retoma a janela do Steam Link quando o Steam Deck reinicia.",
    }))
    subprocess.run(["codesign", "--force", "--sign", "-", "--identifier", NAME, app], check=True)
    subprocess.run(["codesign", "--verify", "--strict", app], check=True)


def wait_for_access():
    """Start the resident process only after a fresh app instance confirms access."""
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "status"
        deadline = time.monotonic() + 180
        prompted = False
        while True:
            output.write_text("")
            subprocess.run(
                ["open", "-n", "-W", "-g", "--stdout", output, "-a", APP, "--args", "--status"],
                check=True, timeout=15,
            )
            if "accessibility=true" in output.read_text():
                return
            if not prompted:
                print("Ative Deck Link em Privacidade e Segurança → Acessibilidade.", flush=True)
                subprocess.run(["open", "-n", "-g", "-a", APP, "--args", "--authorize"], check=True)
                prompted = True
            if time.monotonic() >= deadline:
                raise TimeoutError("Autorize o Deck Link e repita a instalação.")
            time.sleep(3)


def install(host_name):
    if sys.platform != "darwin":
        raise SystemExit("O Deck Link requer macOS.")
    target = DOMAIN + "/" + NAME
    log = HOME / "Library/Logs/deck-runner/steam-link.log"
    for directory in [APP.parent, PLIST.parent, RECEIPT.parent, log.parent]:
        directory.mkdir(parents=True, exist_ok=True)
    binary = APP / "Contents/MacOS/DeckLink"
    if APP.exists() and plistlib.loads((APP / "Contents/Info.plist").read_bytes())["CFBundleIdentifier"] != NAME:
        raise SystemExit(f"O aplicativo em {APP} pertence a outro projeto.")
    identical = (binary.is_file() and RECEIPT.exists()
                 and RECEIPT.read_text().splitlines() == [digest(SOURCE), digest(binary)])
    args = [str(binary)] + ([] if host_name == "steamdeck" else [host_name])
    definition = plistlib.dumps(dict(Label=NAME, ProgramArguments=args, RunAtLoad=True,
                                     KeepAlive=True, ThrottleInterval=10, StandardErrorPath=str(log)))
    old_definition = PLIST.read_bytes() if PLIST.exists() else None
    loaded = subprocess.run(["launchctl", "print", target], capture_output=True).returncode == 0
    if identical and loaded and definition == old_definition:
        print("O Deck Link já está instalado com esta versão.")
        return
    with tempfile.TemporaryDirectory(dir=APP.parent, prefix=".deck-link-") as tmp:
        staged, previous = Path(tmp) / "Deck Link.app", Path(tmp) / "previous.app"
        if not identical:
            build(staged)
        if loaded:
            subprocess.run(["launchctl", "bootout", target], check=True)
        try:
            if not identical:
                if APP.exists():
                    APP.rename(previous)
                staged.rename(APP)
            wait_for_access()
            PLIST.write_bytes(definition)
            subprocess.run(["launchctl", "bootstrap", DOMAIN, PLIST], check=True)
        except BaseException:
            if not identical and APP.exists() and not staged.exists():
                APP.rename(staged)
            if previous.exists():
                previous.rename(APP)
            if old_definition is None:
                PLIST.unlink(missing_ok=True)
            else:
                PLIST.write_bytes(old_definition)
                if loaded:
                    subprocess.run(["launchctl", "bootstrap", DOMAIN, PLIST], check=True)
            raise
        RECEIPT.write_text(digest(SOURCE) + "\n" + digest(binary) + "\n")
    print(f"Deck Link instalado em {APP}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host-name", default="steamdeck", help="Nome do Deck exibido no Steam Link.")
    install(parser.parse_args().host_name)
