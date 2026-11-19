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


def call(action, job=None, stdin=None, raw=False):
    command = shlex.join(["python3", REMOTE, action] + ([job] if job else []))
    p = subprocess.run(
        SSH + [command], stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    if p.returncode:
        raise RuntimeError(
            p.stderr.decode(errors="replace").strip()
            or "Deck unavailable; no local tests were started"
        )
    return p.stdout if raw else json.loads(p.stdout)


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
    repo = Path(git(repo, "rev-parse", "--show-toplevel").decode().strip())
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
    print(
        f"Memória disponível: {s['available_memory'] / 1024**3:.1f} GiB | disco livre: {s['disk_free'] / 1024**3:.0f} GiB"
    )
    if s["reason"]:
        print(s["reason"])
    for j in s["jobs"][:20]:
        m = j["meta"]
        print(
            f"{j['id']}  {j['state']:12}  {m['owner']} | {m['project']} | {m['label']}"
        )


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
    submit.add_argument("--timeout", type=int, default=1800)
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
    sub.add_parser(
        "doctor", help="Check SSH, the executor and the local dashboard tunnel"
    )
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
        print(f"SSH → {HOST}", flush=True)
        remote = call("status")
        if not remote["alive"]:
            raise RuntimeError("SSH conectado. Verifique deck-runner.service no Deck.")
        print("Executor ativo.", flush=True)
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{settings.PORT}/api/status", timeout=5
            ) as res:
                local = json.load(res)
        except (OSError, ValueError) as exc:
            raise RuntimeError(
                "Executor ativo, mas o túnel local não respondeu. Rode o instalador do Mac novamente."
            ) from exc
        if not local.get("instance") or local["instance"] != remote.get("instance"):
            raise RuntimeError(
                "A porta local pertence a outro serviço. Confira o túnel."
            )
        print(
            f"Painel conectado ao mesmo Deck · {len(local['projects'])} projetos · http://127.0.0.1:{settings.PORT}/"
        )
        return 0
    if args.action == "open":
        subprocess.run(["open", f"http://127.0.0.1:{settings.PORT}/"], check=True)
        return
    if args.action == "submit":
        state = call("status")
        if not state["alive"]:
            raise RuntimeError("Deck executor offline; nothing submitted")
        command = args.command
        if command[:1] == ["--"]:
            command = command[1:]
        identity = str(catalog.common_dir(Path(args.repo).expanduser()))
        project = next((p for p in state["projects"] if p["common"] == identity), None)
        if not project:
            raise ValueError("Project not registered. Use deck-runner add PATH.")
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
        previous = None
        while True:
            job = call("job", args.id)
            if job["state"] != previous:
                print(f"{args.id}: {job['state']}", file=sys.stderr)
                previous = job["state"]
            if job["state"] in FINISHED:
                print(json.dumps(job, ensure_ascii=False))
                return 0 if job["state"] == "passed" else 1
            time.sleep(max(1, args.poll))
    else:
        print(json.dumps(call(args.action, args.id), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as e:
        print("deck-runner: " + str(e), file=sys.stderr)
        sys.exit(2)
