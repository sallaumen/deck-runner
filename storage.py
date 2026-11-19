"""Allocated blocks in the runner's four project directories. Never walk the user's home."""

import contextlib
import re
import secrets
import subprocess
import sqlite3
import threading
import time
import traceback

GIB = 1024**3
RESERVE = 10 * GIB
STOP_AT = RESERVE + 2 * GIB
ADMIT_AT = RESERVE + 5 * GIB
GROUPS = ("worktrees", "cache", "repos", "jobs")
REMOVE_LOCK = threading.Lock()
CACHE_KEY = re.compile(r"(.+)-[0-9a-f]{12}-(?:[0-9a-f]{16}|unlocked)(?:-[0-9]+)?")


def allocated(parent):
    if not parent.exists():
        return {}
    if parent.is_symlink():
        raise ValueError("Diretório de testes inesperado.")
    read = subprocess.run(
        ["nice", "-n", "10", "du", "-k", "-x", "-d", "1", str(parent)],
        capture_output=True,
        text=True,
        timeout=180,
    )
    # A checkout may disappear during a scan. Retry rather than publishing partial totals.
    if read.returncode:
        raise OSError("Medição interrompida. Tentando novamente.")
    sizes = {}
    for line in read.stdout.splitlines():
        blocks, path = line.split("\t", 1)
        if path != str(parent):
            sizes[path.rsplit("/", 1)[-1]] = int(blocks) * 1024
    return sizes


def inspect(root, db):
    with contextlib.closing(db()) as c:
        jobs = {
            job: (project, finished)
            for job, project, finished in c.execute(
                "SELECT id,json_extract(meta,'$.project'),finished FROM jobs"
            )
        }
        registered = {row[0] for row in c.execute("SELECT name FROM projects")}
    by_project = {}
    totals = dict.fromkeys(GROUPS, 0)
    candidates = {}
    for group in GROUPS:
        for name, size in allocated(root / group).items():
            if group == "repos":
                project = name.removesuffix(".git") if name.endswith(".git") else None
            elif group == "cache":
                match = CACHE_KEY.fullmatch(name)
                project = match[1] if match else None
            else:
                project, finished = jobs.get(name, (None, None))
                if (
                    group == "worktrees"
                    and finished is not None
                    and project in registered
                ):
                    candidates[name] = (project, size)
            totals[group] += size
            key = project if project in registered else None
            row = by_project.setdefault(key, dict.fromkeys(GROUPS, 0))
            row[group] += size
    rows = [
        dict(name=name, total=sum(sizes.values()), **sizes)
        for name, sizes in by_project.items()
    ]
    report = dict(
        total=sum(totals.values()),
        groups=totals,
        projects=sorted(rows, key=lambda r: -r["total"]),
        reclaimable=sum(size for _, size in candidates.values()),
        count=len(candidates),
        measured=time.time(),
        plan=secrets.token_urlsafe(16),
    )
    return report, candidates


def remove_checkout(root, job, project):
    if not re.fullmatch(r"[a-f0-9]{12}", job) or not re.fullmatch(
        r"[a-z0-9][a-z0-9._-]{0,63}", project
    ):
        return False
    repo = root / "repos" / (project + ".git")
    work = root / "worktrees" / job
    with REMOVE_LOCK:
        if (
            not work.is_dir()
            or work.is_symlink()
            or repo.is_symlink()
            or work.parent.is_symlink()
            or repo.parent.is_symlink()
        ):
            return False
        # Git verifies the worktree is registered with this specific bare repository.
        return (
            subprocess.run(
                ["git", "-C", str(repo), "worktree", "remove", "--force", str(work)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=120,
            ).returncode
            == 0
        )


class Inventory:
    def __init__(self, root, db):
        self.root, self.db = root, db
        self.lock = threading.Lock()
        self.state, self.report, self.candidates = "idle", None, {}
        self.last, self.outcome = 0, None

    def view(self):
        with self.lock:
            if self.state in ("idle", "error") and time.monotonic() >= self.last:
                self.state = "measuring"
                threading.Thread(target=self.measure, daemon=True).start()
            return dict(state=self.state, report=self.report, outcome=self.outcome)

    def measure(self):
        try:
            report, candidates = inspect(self.root, self.db)
            with self.lock:
                self.report, self.candidates = report, candidates
                self.state, self.last = "idle", time.monotonic() + 180
        except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as err:
            with self.lock:
                self.state, self.last = "error", time.monotonic() + 10
            print(err, flush=True)

    def clean(self, plan):
        with self.lock:
            if (
                self.state != "idle"
                or time.monotonic() >= self.last
                or not self.report
                or self.report["plan"] != plan
                or not self.candidates
            ):
                return False
            self.state, self.outcome = "cleaning", None
            threading.Thread(
                target=self._clean, args=(self.candidates.copy(),), daemon=True
            ).start()
            return True

    def _clean(self, candidates):
        removed = skipped = 0
        try:
            with contextlib.closing(self.db()) as c:
                for job, (project, _) in candidates.items():
                    eligible = c.execute(
                        "SELECT 1 FROM jobs WHERE id=? AND finished IS NOT NULL AND state NOT IN ('running','queued') AND json_extract(meta,'$.project')=?",
                        (job, project),
                    ).fetchone()
                    try:
                        if eligible and remove_checkout(self.root, job, project):
                            removed += 1
                        else:
                            skipped += 1
                    except (OSError, subprocess.SubprocessError):
                        skipped += 1
        except Exception:
            traceback.print_exc()
            skipped = len(candidates) - removed
        finally:
            with self.lock:
                self.outcome = dict(removed=removed, skipped=skipped)
                self.state, self.candidates = "measuring", {}
            self.measure()
