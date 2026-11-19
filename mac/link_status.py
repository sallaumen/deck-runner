"""Read the installed helper's status without starting a Steam Link session."""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def probe(app):
    # LaunchServices attributes the accessibility check to the signed helper.
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "status"
        output.touch()
        process = subprocess.run(
            ["open", "-n", "-W", "-g", "--stdout", output, "-a", app, "--args", "--status"],
            timeout=15, capture_output=True,
        )
        raw = output.read_text().rstrip("\n")
    match = re.fullmatch(r"accessibility=(true|false) boot=(true|false) window=(.*)", raw, re.S)
    if not match:
        process.check_returncode()
        raise RuntimeError("Deck Link não respondeu ao diagnóstico. Confira a instalação no Mac.")
    access, boot, title = match.groups()
    return access == "true", boot == "true", title == "Streaming Client" or title.endswith("[Streaming]")


def diagnose():
    app = Path.home() / "Applications/Deck Link.app"
    if sys.platform != "darwin" or not app.is_dir():
        raise RuntimeError("Este diagnóstico requer o Deck Link instalado no Mac.")
    unit = subprocess.run(
        ["launchctl", "print", f"gui/{os.getuid()}/io.github.deck-runner.steam-link"],
        capture_output=True, text=True, timeout=5,
    )
    resident = unit.returncode == 0 and bool(re.search(r"^\tstate = running$", unit.stdout, re.M))
    access, boot, streaming = probe(app)
    opened = subprocess.run(["pgrep", "-x", "Steam Link"], capture_output=True, timeout=5).returncode == 0
    if not opened:
        video = "Steam Link fechado"
    elif not access:
        video = "Steam Link aberto · autorize Acessibilidade para verificar o vídeo"
    else:
        video = "Transmitindo" if streaming else "Steam Link aberto · sem transmissão identificada"
    print(video)
    print("Retomada automática · " + ("serviço em execução" if resident else "serviço parado"))
    print("Acessibilidade · " + ("autorizada" if access else "pendente"))
    print("Steam Remote Play no Deck · " + ("pronto" if boot else "aguardando o Steam ou o túnel"))
    return 0 if resident and access and boot else 1
