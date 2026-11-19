#!/usr/bin/env python3
"""Multi-project test executor. SSH is the submission boundary."""

from collections import Counter
import activity
import live
import storage
import argparse
import contextlib
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import threading
import time
import traceback
import urllib.parse
import uuid

from settings import PORT
from profiles import (
    DEFAULT_MIB,
    DESKTOP_MIB,
    GLOBAL_LIMIT,
    MIB,
    POOL_MIB,
    PROJECT_LIMIT,
    check_command,
    validate_project,
)

REPO_LOCK = threading.Lock()
ROOT = Path(
    os.environ.get("DECK_RUNNER_HOME", str(Path.home() / ".local/share/deck-runner"))
)
GIB = storage.GIB
IMAGE = "localhost/deck-runner:mix"
TERMINAL = (
    "passed",
    "failed",
    "cancelled",
    "interrupted",
    "timeout",
    "output_limit",
    "disk_limit",
)
TOKEN = secrets.token_urlsafe(32)
MAX_SLOTS = 32
CGROUP_ROOT = Path("/sys/fs/cgroup")
DECK_SLICE = (
    CGROUP_ROOT / "user.slice" / f"user-{os.getuid()}.slice"
    / f"user@{os.getuid()}.service" / "decktests.slice"
)


def slot_limits(c):
    row = c.execute("SELECT value FROM settings WHERE key='slots'").fetchone()
    return tuple(json.loads(row[0])) if row else (GLOBAL_LIMIT, PROJECT_LIMIT)


def change_limits(form):
    def number(key):
        values = form.get(key, [])
        if len(values) != 1 or not re.fullmatch(r"[1-9][0-9]?", values[0]):
            raise ValueError("Informe dois limites inteiros.")
        return int(values[0])

    new = (number("slots"), number("project_slots"))
    previous = (number("previous_slots"), number("previous_project_slots"))
    if not 1 <= new[1] <= new[0] <= MAX_SLOTS:
        raise ValueError(f"Use de 1 a {MAX_SLOTS} vagas. O limite por projeto precisa caber no total.")
    with contextlib.closing(db()) as c, c:
        c.execute("BEGIN IMMEDIATE")
        current = slot_limits(c)
        if current != previous and new != current:
            return False, current
        c.execute("INSERT OR REPLACE INTO settings VALUES ('slots',?)", (json.dumps(new),))
    return True, new


def pool_budget(slots):
    # Leave overhead inside the tests' cgroup as well as RAM for the desktop.
    ceiling = max(POOL_MIB, slots * DEFAULT_MIB)
    path = DECK_SLICE
    try:
        while path != CGROUP_ROOT:
            limit = (path / "memory.max").read_text().strip()
            if limit != "max":
                ceiling = min(ceiling, max(0, int(limit) // MIB - 512))
            path = path.parent
    except (OSError, ValueError):
        return min(ceiling, POOL_MIB)
    return ceiling


def db():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    c = sqlite3.connect(ROOT / "queue.sqlite", timeout=30)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
    c.execute("""CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, meta TEXT NOT NULL, state TEXT NOT NULL,
      created REAL NOT NULL, started REAL, finished REAL, exit_code INTEGER,
      cancel INTEGER DEFAULT 0, memory INTEGER DEFAULT 0, peak INTEGER DEFAULT 0,
      error TEXT DEFAULT '')""")
    c.execute(
        "CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, common TEXT NOT NULL UNIQUE, config TEXT NOT NULL)"
    )
    c.execute("""CREATE INDEX IF NOT EXISTS jobs_project_result
                 ON jobs(json_extract(meta,'$.project'), finished DESC, id DESC)
                 WHERE finished IS NOT NULL""")
    c.execute("CREATE INDEX IF NOT EXISTS jobs_unfinished ON jobs(id) WHERE finished IS NULL")
    c.execute("CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created)")
    c.execute("CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished) WHERE finished IS NOT NULL")
    c.execute("CREATE INDEX IF NOT EXISTS jobs_running_start ON jobs(started) WHERE state='running'")
    return c


def projects():
    with contextlib.closing(db()) as c:
        return {
            name: json.loads(config)
            for name, config in c.execute(
                "SELECT name,config FROM projects WHERE coalesce(json_extract(config,'$.enabled'),1)=1 ORDER BY name"
            )
        }


def register(p):
    change = p.pop("update", False)
    validate_project(p)
    if "image" in p:
        run(["podman", "image", "exists", p["image"]])
    with contextlib.closing(db()) as c, c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute(
            "SELECT config FROM projects WHERE common=? OR name=?",
            (p["common"], p["name"]),
        ).fetchone()
        if row:
            previous = json.loads(row[0])
            was_enabled = previous.pop("enabled", True)
            if previous == p and was_enabled:
                return p
            if previous != p and not change:
                raise ValueError(
                    "Different settings already registered. Use add --update to change them."
                )
            if previous["common"] != p["common"] or previous["name"] != p["name"]:
                raise ValueError("Project identity belongs to another registration")
            require_idle_project(c, p["name"])
            c.execute(
                "UPDATE projects SET config=? WHERE name=?", (json.dumps(p), p["name"])
            )
            return p
        c.execute(
            "INSERT INTO projects VALUES (?,?,?)",
            (p["name"], p["common"], json.dumps(p)),
        )
    return p


def require_idle_project(c, name):
    busy = c.execute(
        "SELECT 1 FROM jobs WHERE state IN ('running','queued') AND json_extract(meta,'$.project')=?",
        (name,),
    ).fetchone()
    if busy:
        raise ValueError("Aguarde o término das tarefas deste projeto.")


def remove_project(name):
    with contextlib.closing(db()) as c, c:
        c.execute("BEGIN IMMEDIATE")
        require_idle_project(c, name)
        changed = c.execute(
            "UPDATE projects SET config=json_set(config,'$.enabled',0) WHERE name=?",
            (name,),
        )
        if not changed.rowcount:
            raise ValueError("Unknown project")
    return {"name": name, "enabled": False}


def setting(key, value=None):
    with contextlib.closing(db()) as c, c:
        if value is not None:
            c.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, str(value)))
        row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row[0] if row else ""


def update(job, **values):
    with contextlib.closing(db()) as c, c:
        c.execute(
            "UPDATE jobs SET " + ",".join(k + "=?" for k in values) + " WHERE id=?",
            (*values.values(), job),
        )


def jobrow(job):
    if not re.fullmatch("[a-f0-9]{12}", job):
        raise ValueError("Invalid task ID")
    with contextlib.closing(db()) as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (job,)).fetchone()
    if row is None:
        raise ValueError("Task not found")
    return dict(row)


def available_memory():
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    return 0


def gate():
    if setting("paused") == "1":
        return "Pausado: tarefas novas aguardam na fila."
    if shutil.disk_usage(ROOT).free < storage.ADMIT_AT:
        return "Espaço baixo. Novos testes exigem 15 GiB livres, com 10 GiB reservados para o Deck."
    if available_memory() < (DEFAULT_MIB + DESKTOP_MIB) * MIB:
        return "Aguardando memória livre no Deck."
    return ""


def capacity_bytes(active, pool_mib):
    reservations = [
        (m.get("budget_mib", DEFAULT_MIB) * MIB, used) for m, used in active
    ]
    reserved = sum(limit for limit, _ in reservations)
    unused = sum(max(0, limit - used) for limit, used in reservations)
    return min(
        pool_mib * MIB - reserved, available_memory() - DESKTOP_MIB * MIB - unused
    )


def tail_log(path, size):
    try:
        with path.open("rb") as source:
            source.seek(max(0, os.fstat(source.fileno()).st_size - size))
            return source.read(size).decode(errors="replace")
    except FileNotFoundError:
        return ""


def status():
    with contextlib.closing(db()) as c:
        c.execute("BEGIN")
        slots, project_slots = slot_limits(c)
        rows = c.execute("""
            SELECT * FROM jobs WHERE id IN (
                SELECT id FROM jobs WHERE state IN ('running','queued')
                UNION ALL
                SELECT id FROM (SELECT id FROM jobs WHERE finished IS NOT NULL
                                ORDER BY finished DESC, id DESC LIMIT 100)
                UNION ALL
                SELECT (SELECT id FROM jobs
                        WHERE json_extract(meta,'$.project') = p.name AND finished IS NOT NULL
                        ORDER BY finished DESC, id DESC LIMIT 1)
                FROM projects AS p WHERE coalesce(json_extract(config,'$.enabled'),1) = 1
            ) ORDER BY created DESC""").fetchall()
    jobs = []
    for row in rows:
        j = dict(row)
        j["meta"] = json.loads(j["meta"])
        if j["state"] == "running":
            tail = (
                tail_log(ROOT / "jobs" / j["id"] / "output.log", 4096)
                .strip()
                .splitlines()
            )
            j["activity"] = tail[-1][-160:] if tail else ""
        jobs.append(j)
    reason = gate()
    active = [(j["meta"], j["memory"]) for j in jobs if j["state"] == "running"]
    counts = Counter(m["project"] for m, _ in active)
    waiting = [j["meta"] for j in jobs if j["state"] == "queued"]
    pool = pool_budget(slots)
    eligible = [m for m in waiting if counts[m["project"]] < project_slots]
    if waiting and not reason:
        if len(active) >= slots:
            reason = f"Limite do Deck atingido ({len(active)} em execução, limite de {slots})."
        elif not eligible:
            reason = f"Os projetos na fila atingiram o limite de {project_slots} por projeto."
        elif min(
            m.get("budget_mib", DEFAULT_MIB) * MIB for m in eligible
        ) > capacity_bytes(active, pool):
            reason = "Aguardando memória para a próxima tarefa."
    return dict(
        instance=setting("instance_id"),
        jobs=jobs,
        paused=setting("paused") == "1",
        reason=reason,
        alive=time.time() - float(setting("heartbeat") or 0) < 15,
        available_memory=available_memory(),
        disk_free=shutil.disk_usage(ROOT).free,
        disk_reserve=storage.RESERVE,
        disk_admit=storage.ADMIT_AT,
        slots=slots,
        project_slots=project_slots,
        max_slots=MAX_SLOTS,
        projects=list(projects().values()),
        memory_limit=DEFAULT_MIB * MIB,
        pool_mib=pool,
        reserve_mib=DESKTOP_MIB,
        cpu_limit=3,
        pool_cpus=5,
    )


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def validate_meta(m):
    project = projects().get(m.get("project"))
    if not project:
        raise ValueError("Register this repository from the Mac first")
    budget = m.get("budget_mib", DEFAULT_MIB)
    if type(budget) is not int or budget not in (DEFAULT_MIB, 2560, 5120):
        raise ValueError("Invalid task memory budget")
    for field in ("owner", "label"):
        if not isinstance(m.get(field), str) or not 1 <= len(m[field]) <= 160:
            raise ValueError("Owner and label are required (1–160 characters)")
    for field in ("source_commit", "snapshot_commit", "tree"):
        if not re.fullmatch("[a-f0-9]{40}", m.get(field, "")):
            raise ValueError("Invalid source identity")
    check_command(project["profile"], m.get("command"), project.get("test"))
    if not isinstance(m.get("timeout"), int) or not 30 <= m["timeout"] <= 7200:
        raise ValueError("Timeout must be between 30 and 7200 seconds")


def file_digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def ingest(stream):
    if time.time() - float(setting("heartbeat") or 0) > 20:
        raise ValueError("Executor offline; no task submitted")
    if shutil.disk_usage(ROOT).free < storage.ADMIT_AT:
        raise ValueError("Envio recusado. São necessários 15 GiB livres para preservar 10 GiB no Deck.")
    job = uuid.uuid4().hex[:12]
    folder = ROOT / "jobs" / job
    folder.mkdir(parents=True)
    try:
        package = folder / "upload.tar"
        count = 0
        with package.open("wb") as out:
            while chunk := stream.read(1024 * 1024):
                count += len(chunk)
                if count > 1024 * MIB:
                    raise ValueError("Snapshot exceeds 1 GiB")
                if shutil.disk_usage(ROOT).free - len(chunk) <= storage.STOP_AT:
                    raise ValueError("Envio interrompido para preservar a reserva do Deck.")
                out.write(chunk)
        with tarfile.open(package, mode="r:") as tar:
            members = tar.getmembers()
            if sorted(x.name for x in members) != [
                "meta.json",
                "snapshot.bundle",
            ] or any(not x.isfile() for x in members):
                raise ValueError("Invalid snapshot package")
            if tar.getmember("meta.json").size > 65536:
                raise ValueError("Metadata too large")
            meta = json.load(tar.extractfile("meta.json"))
            validate_meta(meta)
            with (folder / "snapshot.bundle").open("wb") as f:
                source = tar.extractfile("snapshot.bundle")
                while chunk := source.read(MIB):
                    if shutil.disk_usage(ROOT).free - len(chunk) <= storage.STOP_AT:
                        raise ValueError("Espaço insuficiente para armazenar o teste.")
                    f.write(chunk)
        package.unlink()
        meta["bundle_sha256"] = file_digest(folder / "snapshot.bundle")
        with contextlib.closing(db()) as c, c:
            c.execute("BEGIN IMMEDIATE")
            validate_meta(meta)
            if shutil.disk_usage(ROOT).free < storage.ADMIT_AT:
                raise ValueError("Disco abaixo de 15 GiB livres. Teste não enviado.")
            c.execute(
                "INSERT INTO jobs (id,meta,state,created) VALUES (?,?,?,?)",
                (job, json.dumps(meta), "queued", time.time()),
            )
        return {
            "id": job,
            "state": "queued",
            "snapshot_commit": meta["snapshot_commit"],
            "tree": meta["tree"],
        }
    except BaseException:
        shutil.rmtree(folder, ignore_errors=True)
        raise


def claim():
    with contextlib.closing(db()) as c, c:
        c.execute("BEGIN IMMEDIATE")
        paused = c.execute("SELECT value FROM settings WHERE key='paused'").fetchone()
        if paused and paused[0] == "1":
            return None
        active = [
            (json.loads(r["meta"]), r["memory"])
            for r in c.execute("SELECT meta,memory FROM jobs WHERE state='running'")
        ]
        slots, project_slots = slot_limits(c)
        if len(active) >= slots or shutil.disk_usage(ROOT).free < storage.ADMIT_AT:
            return None
        counts = Counter(m["project"] for m, _ in active)
        capacity = capacity_bytes(active, pool_budget(slots))
        queue = [
            (row["id"], json.loads(row["meta"]))
            for row in c.execute(
                "SELECT id,meta FROM jobs WHERE state='queued' ORDER BY created,id"
            )
        ]
        # Stable sort keeps FIFO within each project; favor projects using fewer slots.
        seen_projects = set()
        for job, m in sorted(queue, key=lambda item: counts[item[1]["project"]]):
            name = m["project"]
            if name in seen_projects:
                continue
            seen_projects.add(name)
            if (
                counts[name] >= project_slots
                or m.get("budget_mib", DEFAULT_MIB) * MIB > capacity
            ):
                continue
            used = {
                other.get("lane", 0) for other, _ in active if other["project"] == name
            }
            m["lane"] = next(i for i in range(project_slots) if i not in used)
            c.execute(
                "UPDATE jobs SET state='running',started=?,meta=? WHERE id=?",
                (time.time(), json.dumps(m), job),
            )
            return job


def cancel(job):
    jobrow(job)
    with contextlib.closing(db()) as c, c:
        c.execute(
            "UPDATE jobs SET cancel=1 WHERE id=? AND state IN ('queued','running')",
            (job,),
        )
        c.execute(
            "UPDATE jobs SET state='cancelled',finished=? WHERE id=? AND state='queued'",
            (time.time(), job),
        )


def stop_container(job):
    subprocess.run(
        ["podman", "rm", "-f", "deck-job-" + job],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )


def sample_memory(job):
    try:
        pid = (
            subprocess.check_output(
                ["podman", "inspect", "--format", "{{.State.Pid}}", "deck-job-" + job],
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            .decode()
            .strip()
        )
        cg = Path("/proc", pid, "cgroup").read_text().strip().split("::", 1)[1]
        root = Path("/sys/fs/cgroup") / cg.lstrip("/")
        return int((root / "memory.current").read_text()), int(
            (root / "memory.peak").read_text()
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0, 0


class DiskReserveError(Exception):
    pass


def prepare_command(argv, log, timeout):
    # Git can write a large checkout before the test container starts.
    deadline = time.monotonic() + timeout

    def check_space():
        if shutil.disk_usage(ROOT).free <= storage.STOP_AT:
            raise DiskReserveError(
                "Preparação interrompida para preservar 10 GiB no Deck."
            )

    check_space()
    with subprocess.Popen(
        argv, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
    ) as child:
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(argv, timeout)
                try:
                    code = child.wait(timeout=min(0.5, remaining))
                except subprocess.TimeoutExpired:
                    check_space()
                    continue
                if code:
                    raise subprocess.CalledProcessError(code, argv)
                return
        finally:
            if child.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)


def execute(job):
    row = jobrow(job)
    meta = json.loads(row["meta"])
    folder = ROOT / "jobs" / job
    project = projects()[meta["project"]]
    repo = ROOT / "repos" / (project["name"] + ".git")
    work = ROOT / "worktrees" / job
    started = time.monotonic()
    outcome, code, error = "failed", 1, ""
    process = None
    try:
        with (folder / "output.log").open("wb", buffering=0) as log:

            def command(argv):
                remaining = min(120, meta["timeout"] - (time.monotonic() - started))
                return prepare_command(argv, log, remaining)

            repo.parent.mkdir(exist_ok=True)
            work.parent.mkdir(exist_ok=True)
            with REPO_LOCK:
                if not repo.exists():
                    command(["git", "init", "--bare", str(repo)])
                command(
                    [
                        "git",
                        "-C",
                        str(repo),
                        "fetch",
                        str(folder / "snapshot.bundle"),
                        "HEAD:refs/jobs/" + job,
                    ]
                )
            snapshot = (
                subprocess.check_output(
                    ["git", "-C", str(repo), "rev-parse", "refs/jobs/" + job]
                )
                .decode()
                .strip()
            )
            tree = (
                subprocess.check_output(
                    ["git", "-C", str(repo), "rev-parse", snapshot + "^{tree}"]
                )
                .decode()
                .strip()
            )
            if snapshot != meta["snapshot_commit"] or tree != meta["tree"]:
                raise ValueError("Snapshot identity mismatch")
            command(
                [
                    "git",
                    "-C",
                    str(repo),
                    "worktree",
                    "add",
                    "--detach",
                    str(work),
                    snapshot,
                ]
            )
            lockfile = work / "mix.lock"
            lock = file_digest(lockfile)[:16] if lockfile.exists() else "unlocked"
            profile = project["profile"]
            image = (
                "docker.io/library/node:22-bookworm-slim"
                if profile == "node"
                else project.get("image", IMAGE)
            )
            image_id = (
                subprocess.check_output(
                    ["podman", "image", "inspect", "--format", "{{.Id}}", image],
                    timeout=10,
                )
                .decode()
                .strip()
            )
            meta["runtime_image"] = image_id
            update(job, meta=json.dumps(meta))
            cache = (
                ROOT
                / "cache"
                / (f"{project['name']}-{image_id[:12]}-{lock}-{meta['lane']}")
            )
            mounts = []
            for name in ("deps", "_build") if profile == "mix" else ():
                (cache / name).mkdir(parents=True, exist_ok=True)
                (work / name).mkdir(exist_ok=True)
                mounts += ["-v", f"{cache / name}:{work / name}:rw"]
            if cache.exists():
                os.utime(cache, None)
            budget = str(meta.get("budget_mib", DEFAULT_MIB)) + "m"
            argv = [
                "podman",
                "run",
                "--name",
                "deck-job-" + job,
                "--pull=never",
                "--userns=keep-id",
                "--user=1000" if profile in ("node", "custom") else "--user=0",
                "--memory=" + budget,
                "--memory-swap=" + budget,
                "--cgroup-parent=decktests.slice",
                "--cpus=3",
                "--pids-limit=1024",
                "--security-opt=no-new-privileges",
                "--label",
                "local.deck-runner=true",
                "-v",
                f"{work}:{work}:rw",
                "-v",
                f"{repo}:{repo}:ro",
                *mounts,
                "-w",
                str(work),
                *(
                    []
                    if project.get("no_test_partition")
                    else ["-e", "MIX_TEST_PARTITION=_deck_" + job]
                ),
                "-e",
                "DECK_PROFILE=" + profile,
                "-e",
                "DECK_DB_USER=" + project["db_user"],
                "-e",
                "DECK_DB_PORT=" + str(project["port"]),
                "-e",
                "ERL_FLAGS=+S 2:2",
                "-e",
                "TEST_MAX_CASES=2",
                "-v",
                f"{Path(__file__).resolve().parent / 'run-project.sh'}:/deck-test:ro",
                "--entrypoint=/bin/sh",
                image_id,
                "/deck-test",
                *meta["command"],
            ]
            log.write(
                (
                    "Source: "
                    + meta["source_commit"]
                    + "\nSnapshot: "
                    + snapshot
                    + "\nTree: "
                    + tree
                    + "\n"
                ).encode()
            )
            if profile == "custom":
                # Run the enrolled command directly. Custom images need no shell or project bootstrap.
                entry = argv.index("--entrypoint=/bin/sh")
                argv[entry:] = [
                    "--entrypoint=" + meta["command"][0],
                    image_id,
                    *meta["command"][1:],
                ]
            if shutil.disk_usage(ROOT).free <= storage.STOP_AT:
                raise DiskReserveError("Teste interrompido para preservar 10 GiB no Deck.")
            process = subprocess.Popen(argv, stdout=log, stderr=subprocess.STDOUT)
            next_sample = 0
            while process.poll() is None:
                if jobrow(job)["cancel"]:
                    outcome, error = "cancelled", "Cancelled by request"
                    stop_container(job)
                    break
                if time.monotonic() - started > meta["timeout"]:
                    outcome, error = "timeout", "Task exceeded its time limit"
                    stop_container(job)
                    break
                if (folder / "output.log").stat().st_size > 50 * 1024 * 1024:
                    outcome, error = "output_limit", "Log exceeded 50 MiB"
                    stop_container(job)
                    break
                if shutil.disk_usage(ROOT).free <= storage.STOP_AT:
                    outcome, error = "disk_limit", "Teste interrompido para preservar 10 GiB no Deck."
                    stop_container(job)
                    break
                if time.monotonic() > next_sample:
                    current, peak = sample_memory(job)
                    update(job, memory=current, peak=max(peak, jobrow(job)["peak"]))
                    next_sample = time.monotonic() + 5
                time.sleep(0.5)
            code = process.wait(timeout=30)
            if not error:
                outcome = "passed" if code == 0 else "failed"
                if jobrow(job)["cancel"]:
                    outcome, error = (
                        "cancelled",
                        "Cancellation requested before completion",
                    )
            log.write(f"\nExecutor result: {outcome}; exit code: {code}\n".encode())
    except Exception as exc:
        if isinstance(exc, DiskReserveError):
            outcome = "disk_limit"
        elif isinstance(exc, subprocess.TimeoutExpired):
            outcome = "timeout"
        error = str(exc)
        with (folder / "output.log").open("a") as log:
            traceback.print_exc(file=log)
    finally:
        stop_container(job)
        if process and process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
        # Keep output files for inspection for one day; dependency caches are separate.
        (folder / "snapshot.bundle").unlink(missing_ok=True)
        update(
            job,
            state=outcome,
            exit_code=code,
            finished=time.time(),
            memory=0,
            error=error,
        )
        (folder / "result.json").write_text(
            json.dumps({**jobrow(job), "meta": meta}, indent=2)
        )


def cleanup():
    with contextlib.closing(db()) as c:
        rows = c.execute(
            "SELECT id,finished,meta FROM jobs WHERE finished IS NOT NULL"
        ).fetchall()
    for row in rows:
        repo = ROOT / "repos" / (json.loads(row["meta"])["project"] + ".git")
        age = time.time() - row["finished"]
        work = ROOT / "worktrees" / row["id"]
        if age > 86400 and work.exists():
            storage.remove_checkout(ROOT, row["id"], json.loads(row["meta"])["project"])
        if age > 7 * 86400:
            shutil.rmtree(ROOT / "jobs" / row["id"], ignore_errors=True)
            subprocess.run(
                ["git", "-C", str(repo), "update-ref", "-d", "refs/jobs/" + row["id"]],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    for cache in (ROOT / "cache").glob("*") if (ROOT / "cache").exists() else []:
        if time.time() - cache.stat().st_mtime > 7 * 86400:
            shutil.rmtree(cache)


def worker():
    last_cleanup = 0
    while True:
        try:
            if time.monotonic() - last_cleanup > 3600:
                cleanup()
                last_cleanup = time.monotonic()
            if not gate() and (job := claim()):
                threading.Thread(target=execute, args=(job,), daemon=True).start()
        except Exception:
            traceback.print_exc()
        time.sleep(2)


def heartbeat():
    while True:
        setting("heartbeat", time.time())
        time.sleep(3)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, body, kind="text/html; charset=utf-8", code=200):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; form-action 'self'",
        )
        self.end_headers()
        self.wfile.write(data)

    def valid_host(self):
        port = self.server.server_port
        return self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def activity(self, hours):
        with contextlib.closing(db()) as connection:
            connection.execute("BEGIN")
            return activity.from_database(connection, hours, int(time.time()))

    def do_GET(self):
        if not self.valid_host():
            return self.send("Invalid host", code=403)
        path = urllib.parse.urlsplit(self.path).path
        try:
            assets = Path(__file__).parent / "web"
            if path in (
                "/assets/dashboard.css",
                "/assets/dashboard.js",
                "/assets/motion.js",
                "/assets/motion.css",
                "/assets/controller.js",
                "/assets/activity.js",
                "/assets/limits.js",
                "/assets/storage.js",
                "/assets/icon.svg",
                "/assets/pilot.png",
            ):
                asset = assets / path.split("/")[-1]
                mime = {
                    ".css": "text/css",
                    ".js": "application/javascript",
                    ".svg": "image/svg+xml",
                    ".png": "image/png",
                }[asset.suffix]
                return self.send(asset.read_bytes(), mime if asset.suffix == ".png" else mime + "; charset=utf-8")
            if path == "/api/activity":
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True)
                values = query.get("hours", ["6"])
                if len(values) != 1 or values[0] not in tuple(map(str, activity.PERIODS)):
                    return self.send("Unsupported period", code=400)
                return self.send(json.dumps(self.activity(int(values[0]))), "application/json")
            if path == "/api/events":
                return self.server.changes.stream(self)
            if path == "/api/storage":
                return self.send(json.dumps(self.server.inventory.view()), "application/json")
            if path == "/api/boot":
                return self.send(Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "text/plain")
            if path == "/api/status":
                return self.send(json.dumps(status()), "application/json")
            if path.startswith("/logs/"):
                job = path.removeprefix("/logs/")
                jobrow(job)
                p = ROOT / "jobs" / job / "output.log"
                text = (
                    tail_log(p, 250000)
                    or "Aguardando execução; logs são mantidos por sete dias."
                )
                return self.send(text, "text/plain; charset=utf-8")
            if path.startswith("/result/"):
                row = jobrow(path.removeprefix("/result/"))
                row["meta"] = json.loads(row["meta"])
                return self.send(
                    json.dumps(row, indent=2, ensure_ascii=False), "application/json"
                )
            if path != "/":
                return self.send("Not found", code=404)
            page = (assets / "dashboard.html").read_text().replace("__TOKEN__", TOKEN)
            return self.send(page)
        except ValueError as e:
            self.send(str(e), code=404)

    def do_POST(self):
        if not self.valid_host() or self.headers.get(
            "Origin"
        ) != "http://" + self.headers.get("Host", ""):
            return self.send("Forbidden", code=403)
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size < 4096:
            return self.send("Invalid request", code=400)
        form = urllib.parse.parse_qs(self.rfile.read(size).decode())
        if not secrets.compare_digest(form.get("token", [""])[0], TOKEN):
            return self.send("Invalid token; reload the page", code=403)
        if self.path == "/storage/clean":
            started = self.server.inventory.clean(form.get("plan", [""])[0])
            return self.send(json.dumps({"started": started}), "application/json", code=202 if started else 409)
        if self.path == "/limits":
            try:
                changed, (slots, project_slots) = change_limits(form)
            except ValueError as e:
                return self.send(str(e), code=400)
            return self.send(
                json.dumps(dict(slots=slots, project_slots=project_slots)),
                "application/json", code=200 if changed else 409,
            )
        if self.path == "/pause":
            setting("paused", "1")
        elif self.path == "/resume":
            setting("paused", "0")
        elif self.path == "/display/close":
            try:
                subprocess.run(
                    ["systemctl", "--user", "stop", "--no-block", "deck-runner-display.service"],
                    check=True, timeout=5,
                )
            except (OSError, subprocess.SubprocessError):
                return self.send("Display unavailable", code=503)
            return self.send("", code=204)
        elif self.path.startswith("/cancel/"):
            cancel(self.path.removeprefix("/cancel/"))
        else:
            return self.send("Not found", code=404)
        self.send_response(303)
        self.send_header("Location", "/")
        self.end_headers()


class LegacyRedirect(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Keep the destination local even for an absolute or scheme-relative request.
        url = urllib.parse.urlsplit(self.path)
        path = url.path if url.path.startswith("/") else "/"
        self.send_response(302)
        self.send_header(
            "Location",
            urllib.parse.urlunsplit(("http", f"127.0.0.1:{PORT}", path, url.query, "")),
        )
        self.end_headers()

    def log_message(self, *args):
        pass


def serve():
    with (ROOT / "worker.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with contextlib.closing(db()) as c:
            rows = c.execute("SELECT id FROM jobs WHERE state='running'").fetchall()
        for row in rows:
            stop_container(row["id"])
            update(
                row["id"],
                state="interrupted",
                finished=time.time(),
                memory=0,
                error="Executor restarted; task was not reported as passed",
            )
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        if not setting("instance_id"):
            setting("instance_id", uuid.uuid4().hex)
        legacy = os.environ.get("DECK_RUNNER_LEGACY_PORT")
        if legacy and int(legacy) != PORT:
            try:
                redirect = http.server.ThreadingHTTPServer(
                    ("127.0.0.1", int(legacy)), LegacyRedirect
                )
                threading.Thread(target=redirect.serve_forever, daemon=True).start()
            except OSError as err:
                print(f"Old bookmarks unavailable: {err}", file=sys.stderr)
        httpd.inventory = storage.Inventory(ROOT, db)
        httpd.changes = live.Changes()
        threading.Thread(target=httpd.changes.observe, args=(db,), daemon=True).start()
        threading.Thread(target=heartbeat, daemon=True).start()
        threading.Thread(target=worker, daemon=True).start()
        httpd.serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=[
            "serve",
            "register",
            "remove",
            "submit",
            "status",
            "job",
            "logs",
            "cancel",
            "pause",
            "resume",
        ],
    )
    parser.add_argument("id", nargs="?")
    args = parser.parse_args()
    with contextlib.closing(db()):
        pass
    if args.action == "serve":
        return serve()
    if args.action == "register":
        result = register(json.load(sys.stdin))
    elif args.action == "remove":
        result = remove_project(args.id)
    elif args.action == "submit":
        result = ingest(sys.stdin.buffer)
    elif args.action == "status":
        result = status()
    elif args.action == "job":
        result = jobrow(args.id)
        result["meta"] = json.loads(result["meta"])
    elif args.action == "logs":
        jobrow(args.id)
        p = ROOT / "jobs" / args.id / "output.log"
        if p.exists():
            sys.stdout.buffer.write(p.read_bytes())
        return
    elif args.action == "cancel":
        cancel(args.id)
        result = jobrow(args.id)
    else:
        setting("paused", "1" if args.action == "pause" else "0")
        result = status()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.SubprocessError, OSError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
