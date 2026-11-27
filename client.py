#!/usr/bin/env python3
"""Mac client. It never builds or tests locally and never modifies the source checkout."""

import argparse
import catalog
import settings
import urllib.request
from profiles import COMMANDS, DEFAULT_MIB, check_command
import hashlib
import json
import os
import re
import ssl
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

HOST = settings.host()
REMOTE = ".local/share/deck-runner/app/server.py"
SSH = ["ssh", *settings.ssh_options(), HOST]
FINISHED = {
    "passed",
    "failed",
    "cancelled",
    "interrupted",
    "timeout",
    "output_limit",
    "disk_limit",
}
EXCLUDE = {".cyclops", ".idea", ".playwright-mcp", ".DS_Store"}


class RunnerError(RuntimeError):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code


def ssh_error(detail):
    message = detail.lower()
    # OpenSSH can fall back to a fresh connection after a control socket error.
    if "host key verification failed" in message or "remote host identification has changed" in message:
        return RunnerError("ssh_host_key", detail)
    if "permission denied (" in message:
        return RunnerError("ssh_auth", detail)
    if any(
        ("operation not permitted" in line or "permission denied" in line)
        and ("control socket connect(" in line or "connect to host " in line)
        for line in message.splitlines()
    ):
        return RunnerError("session_socket_denied", detail + (
            "\nO sistema negou acesso ao socket SSH nesta sessão. "
            "Consulte o perfil de rede do processo e a validação por worktree em "
            f"{Path(__file__).resolve().with_name('README.md')}."
        ))
    if "could not resolve hostname" in message:
        return RunnerError("ssh_dns", detail)
    if any(fragment in message for fragment in (
        "timed out", "connection refused", "connection reset",
        "broken pipe", "connection closed", "closed by remote host", "no route to host",
        "network is unreachable", "timeout, server",
    )):
        return RunnerError("ssh_connection", detail)
    return RunnerError("ssh_error", detail)


def call(action, job=None, stdin=None, raw=False):
    command = shlex.join(["python3", REMOTE, action] + ([job] if job else []))
    try:
        p = subprocess.run(
            SSH + [command], stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=45 if action in ("status", "job") else None,
        )
    except subprocess.TimeoutExpired as exc:
        raise RunnerError("ssh_timeout", f"Tempo esgotado consultando {action} via SSH em {HOST}.") from exc
    if p.returncode:
        detail = p.stderr.decode(errors="replace").strip() or f"SSH exit {p.returncode}"
        if p.returncode == 255:
            raise ssh_error(detail)
        raise RuntimeError(detail)
    if raw:
        return p.stdout
    try:
        return json.loads(p.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RunnerError("station_response", f"Resposta JSON inválida do executor ao consultar {action}.") from exc


def git(repo, *args):
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], stderr=subprocess.PIPE
    )


def sensitive(path):
    p = Path(path)
    return (
        p.name
        in {
            ".env.local",
            ".env.production",
            ".env.development",
            "id_rsa",
            "id_ed25519",
            "credentials.json",
        }
        or p.suffix in {".pem", ".p12", ".pfx", ".key"}
        or any(x in {".ssh", ".aws", ".gnupg"} for x in p.parts)
    )


def public_certificate(path):
    if (
        path.suffix != ".pem"
        or path.is_symlink()
        or not path.is_file()
        or path.stat().st_size > 100000
    ):
        return False
    raw = path.read_bytes().strip()
    if not re.fullmatch(
        rb"-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----", raw
    ):
        return False
    try:
        ssl.create_default_context().load_verify_locations(cadata=raw.decode("ascii"))
    except (ValueError, ssl.SSLError):
        return False
    return True


def check_dotenv(repo, tracked):
    for name in tracked:
        p = repo / name
        if p.name != ".env" and not p.name.startswith(".env."):
            continue
        if not p.exists():
            continue
        if p.is_symlink():
            raise ValueError("Environment file is a symbolic link: " + name)
        for line in p.read_text().splitlines():
            key, sep, value = line.partition("=")
            if (
                sep
                and not key.lstrip().startswith("#")
                and re.search(
                    "KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL", key, re.I
                )
            ):
                if value.strip().strip(chr(34) + chr(39)):
                    raise ValueError(
                        "Tracked environment file contains a populated credential field: "
                        + name
                    )


def signature(path):
    if path.is_symlink():
        return ("link", os.readlink(path))
    if path.is_file():
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        return ("file", digest, path.stat().st_mode & 0o111)
    return ("missing",)


def snapshot(repo, folder, agent, label, command, timeout, project, budget=DEFAULT_MIB):
    repo = Path(git(Path(repo).expanduser(), "rev-parse", "--show-toplevel").decode().strip())
    head = git(repo, "rev-parse", "HEAD").decode().strip()
    tracked = set(git(repo, "ls-files", "-z").decode().split("\0")) - {""}
    untracked = set(
        git(repo, "ls-files", "--others", "--exclude-standard", "-z")
        .decode()
        .split("\0")
    ) - {""}
    ignored = sorted(
        p
        for p in untracked
        if any(x in EXCLUDE for x in Path(p).parts)
        or sensitive(p)
        or Path(p).name.startswith(".env")
    )
    paths = sorted(tracked | (untracked - set(ignored)))
    check_dotenv(repo, tracked)
    if any(sensitive(p) and not public_certificate(repo / p) for p in tracked):
        raise RuntimeError(
            "A tracked file looks like a credential. Remove it from the snapshot source before submitting."
        )
    if any(
        line.startswith(b"160000 ")
        for line in git(repo, "ls-files", "--stage").splitlines()
    ):
        raise RuntimeError(
            "Submodules require explicit project preparation; snapshot was not submitted"
        )
    checkout = folder / "checkout"
    subprocess.run(
        [
            "git",
            "clone",
            "--shared",
            "--no-checkout",
            "--quiet",
            str(repo),
            str(checkout),
        ],
        check=True,
    )
    git(checkout, "read-tree", head)
    signatures = {}
    total = 0
    for name in paths:
        src = repo / name
        if not src.parent.resolve().is_relative_to(repo.resolve()):
            raise RuntimeError("File resolves outside worktree: " + name)
        sig = signature(src)
        signatures[name] = sig
        if sig[0] == "missing":
            continue
        dst = checkout / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        if sig[0] == "link":
            target = sig[1]
            if Path(target).is_absolute() or not (
                src.parent / target
            ).resolve().is_relative_to(repo.resolve()):
                raise RuntimeError(
                    "External symlink needs explicit project preparation: " + name
                )
            dst.symlink_to(target)
        else:
            total += src.stat().st_size
            if total > 1024**3:
                raise RuntimeError("Source snapshot exceeds 1 GiB")
            shutil.copy2(src, dst)
    if git(repo, "rev-parse", "HEAD").decode().strip() != head or any(
        signature(repo / p) != s for p, s in signatures.items()
    ):
        raise RuntimeError("Source changed while copying. Retry after edits finish.")
    current_untracked = set(
        git(repo, "ls-files", "--others", "--exclude-standard", "-z")
        .decode()
        .split("\0")
    ) - {""}
    if current_untracked != untracked:
        raise RuntimeError("New files changed while copying. Retry after edits finish.")
    # This is a private temporary clone, never the user's index or checkout.
    git(checkout, "add", "--all")
    tree = git(checkout, "write-tree").decode().strip()
    commit = (
        git(
            checkout,
            "-c",
            "user.name=Deck Runner",
            "-c",
            "user.email=deck-runner@localhost",
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            tree,
            "-m",
            "Remote test snapshot",
        )
        .decode()
        .strip()
    )
    # A parentless snapshot transports only the submitted tree, including for large repositories.
    git(checkout, "update-ref", "refs/heads/deck-snapshot", commit)
    git(checkout, "symbolic-ref", "HEAD", "refs/heads/deck-snapshot")
    bundle = folder / "snapshot.bundle"
    git(checkout, "bundle", "create", str(bundle), "HEAD")
    meta = dict(
        project=project,
        budget_mib=budget,
        owner=agent,
        label=label,
        command=command,
        timeout=timeout,
        source_commit=head,
        snapshot_commit=commit,
        tree=tree,
        source_path=str(repo),
        source_dirty=tree != git(repo, "rev-parse", head + "^{tree}").decode().strip(),
        untracked_included_count=len(untracked - set(ignored)),
        omitted_untracked_count=len(ignored),
        created_on_mac=time.time(),
    )
    (folder / "meta.json").write_text(json.dumps(meta))
    package = folder / "upload.tar"
    with tarfile.open(package, "w") as tar:
        tar.add(bundle, arcname="snapshot.bundle")
        tar.add(folder / "meta.json", arcname="meta.json")
    return package, meta


def print_status(s):
    print(
        ("ONLINE" if s["alive"] else "OFFLINE")
        + f" | {s['slots']} vagas, até {s['project_slots']} por projeto | "
        + ("PAUSADO" if s["paused"] else "fila ativa")
    )
    cpu = s.get("cpu_percent")  # Absent while the Deck runs an older executor.
    print(
        f"Memória disponível: {s['available_memory'] / 1024**3:.1f} GiB | "
        + (f"CPU em uso: {cpu}% de {s['cpu_count']} núcleos | " if cpu is not None else "")
        + f"disco livre: {s['disk_free'] / 1024**3:.0f} GiB"
    )
    if s["reason"]:
        print(s["reason"])
    for j in s["jobs"][:20]:
        m = j["meta"]
        print(
            f"{j['id']}  {j['state']:12}  {m['owner']} | {m['project']} | {m['label']}"
        )


def doctor(repo):
    url = f"http://127.0.0.1:{settings.PORT}/api/status"
    remote = None
    errors = []
    if repo is None:
        print("Diagnóstico da estação. Nenhum worktree selecionado.")
    try:
        remote = call("status")
        print(f"SSH → {HOST} · respondeu")
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        errors.append(f"Consulta da frente via SSH ({HOST}): {exc}")
    else:
        if not remote["alive"]:
            errors.append("Executor sem resposta. Confira deck-runner.service no Deck.")
        else:
            print("Executor ativo." + (" " + remote["reason"] if remote.get("reason") else ""))
        if uploads_blocked(remote):
            message = "Envio bloqueado pelo limite de disco no Deck."
            if repo is None:
                print(message)
            else:
                errors.append(message)
        if repo is not None:
            try:
                project = registered_project(remote, repo)
                print(f"Worktree cadastrado · {project['name']}")
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                errors.append(f"Cadastro do worktree ({repo}): {exc}")

    try:
        with urllib.request.urlopen(url, timeout=5) as reply:
            local = json.load(reply)
        if not isinstance(local, dict) or not local.get("instance"):
            errors.append(f"Painel local respondeu sem identificar a estação ({url}).")
        elif remote is None:
            print("Painel local respondeu. O acesso SSH desta frente precisa de verificação.")
        elif local["instance"] != remote.get("instance"):
            errors.append("A porta local pertence a outra estação. Confira o túnel.")
        else:
            print(f"Painel no mesmo Deck · {len(remote['projects'])} projetos · {url.removesuffix('api/status')}")
    except (OSError, ValueError) as exc:
        errors.append(f"Painel local ({url}): {exc}")
    if errors:
        raise RuntimeError("\n".join(errors))
    return 0


def uploads_blocked(state):
    # Older stations may omit the disk admission threshold.
    return "disk_admit" in state and state["disk_free"] < state["disk_admit"]


def registered_project(state, repo):
    repo = Path(repo).expanduser()
    common = catalog.common_dir(repo)
    for project in state["projects"]:
        if project["common"] == str(common):
            return project

    # Agents also use standalone clones made directly from the primary checkout.
    # Only compare local paths. A lookup must never contact a Git remote.
    origin = subprocess.run(
        ["git", "-C", str(repo), "config", "--get", "remote.origin.url"],
        capture_output=True, text=True, check=False,
    )
    path = Path(origin.stdout.rstrip("\n"))
    if origin.returncode == 0 and path.is_absolute():
        source = path.resolve()
        for project in state["projects"]:
            registered = Path(project["common"])
            if source in (registered, registered.parent):
                return project
    raise ValueError(
        f"Project not registered: {common}. Use um worktree do projeto cadastrado "
        "ou um clone feito diretamente da pasta principal. Para um novo projeto, "
        "use deck-runner add na pasta principal em ~/projects."
    )


def submission_project(state, repo):
    if not isinstance(state, dict) or not isinstance(state.get("alive"), bool):
        raise RunnerError("station_response", "O executor respondeu sem informar seu estado.")
    if not state["alive"]:
        raise RunnerError("executor_offline", "Deck executor offline; nothing submitted")
    if not isinstance(state.get("projects"), list) or any(
        not isinstance(p, dict) or not isinstance(p.get("common"), str) or not isinstance(p.get("name"), str)
        for p in state["projects"]
    ):
        raise RunnerError("station_response", "O executor respondeu com um cadastro de projetos inválido.")
    if "disk_admit" in state and not all(isinstance(state.get(key), int) for key in ("disk_admit", "disk_free")):
        raise RunnerError("station_response", "O executor respondeu com limites de disco inválidos.")
    if uploads_blocked(state):
        raise RunnerError("disk_limit", "Envio bloqueado pelo limite de disco no Deck.")
    try:
        return registered_project(state, repo)
    except subprocess.CalledProcessError as exc:
        raise RunnerError("git_checkout", f"O Git não conseguiu identificar o checkout em {repo}.") from exc
    except ValueError as exc:
        raise RunnerError("project_registration", str(exc)) from exc


def preflight(repo):
    path = os.path.abspath(os.path.expanduser(repo))
    report = {"host": HOST, "repo": path}
    try:
        state = call("status")
        project = submission_project(state, path)
    except RunnerError as exc:
        report.update(ready=False, code=exc.code, detail=str(exc))
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        report.update(ready=False, code="client_error", detail=str(exc))
    else:
        report.update(ready=True, code="ready", project=project["name"], queue_note=state.get("reason", ""))
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ready"] else 2


def wait_job(job_id, poll):
    previous = None
    failures = 0
    while True:
        try:
            job = call("job", job_id)
            if not isinstance(job, dict) or not isinstance(job.get("state"), str):
                raise RunnerError("station_response", "Resposta do executor sem o estado da tarefa.")
        except RunnerError as exc:
            if exc.code not in {"ssh_timeout", "ssh_connection"} or failures >= 3:
                raise RunnerError(exc.code, f"{exc}\nRetome com deck-runner wait {job_id}.") from exc
            failures += 1
            print(f"{job_id}: {exc.code}. Nova consulta ao mesmo ID ({failures}/3).", file=sys.stderr)
            time.sleep(min(10, max(1, poll)))
            continue
        failures = 0
        if job["state"] != previous:
            print(f"{job_id}: {job['state']}", file=sys.stderr)
            previous = job["state"]
        if job["state"] in FINISHED:
            print(json.dumps(job, ensure_ascii=False))
            return 0 if job["state"] == "passed" else 1
        time.sleep(max(1, poll))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    listing = sub.add_parser(
        "projects", help="List local repositories and their registration"
    )
    listing.add_argument("--json", action="store_true")
    add = sub.add_parser("add", help="Register a repository under ~/projects")
    add.add_argument("repo")
    add.add_argument("--update", action="store_true")
    sub.add_parser(
        "remove", help="Disable a project and preserve its history"
    ).add_argument("id")
    add.add_argument("--name")
    add.add_argument("--profile", choices=COMMANDS)
    add.add_argument(
        "--image", help="Mix or custom profile: OCI image already present on the Deck"
    )
    add.add_argument(
        "--no-test-partition",
        action="store_true",
        help="Mix: use the project’s standard test database name",
    )
    add.add_argument(
        "--test", type=json.loads, help="Custom profile: test argv as a JSON array"
    )
    add.add_argument("--port", type=int, default=5432)
    add.add_argument("--db-user", default="postgres")
    submit = sub.add_parser("submit")
    submit.add_argument("--size", choices=["normal", "large", "xl"], default="normal")
    submit.add_argument("--repo", default=".")
    submit.add_argument(
        "--agent", required=True, help="Agent and chat/task identity shown on dashboard"
    )
    submit.add_argument("--label", required=True)
    submit.add_argument("--timeout", type=int, default=3600)
    submit.add_argument("command", nargs=argparse.REMAINDER)
    for action in ("status", "pause", "resume"):
        p = sub.add_parser(action)
        p.add_argument("--json", action="store_true")
    for action in ("job", "logs", "wait", "cancel"):
        p = sub.add_parser(action)
        p.add_argument("id")
        if action == "logs":
            p.add_argument("--tail", type=int, default=100)
        if action == "wait":
            p.add_argument("--poll", type=int, default=5)
    diag = sub.add_parser(
        "doctor", help="Check SSH, the executor and the local dashboard tunnel"
    )
    scope = diag.add_mutually_exclusive_group()
    scope.add_argument("--repo", help="Verify this worktree (defaults to the current Git checkout)")
    scope.add_argument("--station", action="store_true", help="Check only the station and local tunnel")
    check = sub.add_parser("preflight", help="Check submission readiness over SSH and print JSON")
    check.add_argument("--repo", default=".", help="Checkout to submit (default: current directory)")
    sub.add_parser("video-status", help="Check Steam Link video and automatic reconnection on this Mac")
    sub.add_parser("open")
    args = parser.parse_args()
    if args.action == "projects":
        enabled = {p["common"]: p for p in call("status")["projects"]}
        rows = catalog.discover(Path.home() / "projects")
        for row in rows:
            reg = enabled.get(str(catalog.common_dir(row["path"])))
            row["registered"] = reg["name"] if reg else None
        if args.json:
            print(json.dumps(rows, ensure_ascii=False))
        else:
            for row in rows:
                print(
                    f"{row['name']:32} {row['profile'] or '—':8} {row['registered'] or 'por cadastrar'}"
                )
        return
    if args.action == "add":
        p = catalog.registration(
            args.repo,
            args.name,
            args.profile,
            args.port,
            args.db_user,
            args.image,
            args.test,
            no_test_partition=args.no_test_partition,
        )
        if args.update:
            p["update"] = True
        with tempfile.TemporaryFile() as f:
            f.write(json.dumps(p).encode())
            f.seek(0)
            print(json.dumps(call("register", stdin=f), ensure_ascii=False))
        return
    if args.action == "video-status":
        from mac.link_status import diagnose

        return diagnose()
    if args.action == "doctor":
        repo = args.repo
        if repo is None and not args.station:
            try:
                repo = os.fsdecode(git(".", "rev-parse", "--show-toplevel")).rstrip("\n")
            except subprocess.CalledProcessError:
                pass  # Outside a checkout, only station checks apply.
        return doctor(repo)
    if args.action == "open":
        subprocess.run(["open", f"http://127.0.0.1:{settings.PORT}/"], check=True)
        return
    if args.action == "preflight":
        return preflight(args.repo)
    if args.action == "submit":
        state = call("status")
        project = submission_project(state, args.repo)
        command = args.command
        if command[:1] == ["--"]:
            command = command[1:]
        command = command or project.get("test") or COMMANDS[project["profile"]]
        check_command(project["profile"], command, project.get("test"))
        budget = {"normal": DEFAULT_MIB, "large": 2560, "xl": 5120}[args.size]
        with tempfile.TemporaryDirectory(prefix="deck-snapshot-") as temp:
            package, meta = snapshot(
                args.repo,
                Path(temp),
                args.agent,
                args.label,
                command,
                args.timeout,
                project["name"],
                budget,
            )
            with package.open("rb") as f:
                result = call("submit", stdin=f)
        print(json.dumps(result, ensure_ascii=False))
        if meta["omitted_untracked_count"]:
            print(
                "Excluded local state/credential files: "
                + str(meta["omitted_untracked_count"]),
                file=sys.stderr,
            )
    elif args.action in ("status", "pause", "resume"):
        s = call(args.action)
        print(json.dumps(s, ensure_ascii=False)) if args.json else print_status(s)
    elif args.action == "logs":
        lines = call("logs", args.id, raw=True).decode(errors="replace").splitlines()
        print("\n".join(lines[-args.tail :] if args.tail > 0 else lines))
    elif args.action == "wait":
        return wait_job(args.id, args.poll)
    else:
        print(json.dumps(call(args.action, args.id), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as e:
        print("deck-runner: " + str(e), file=sys.stderr)
        sys.exit(2)
