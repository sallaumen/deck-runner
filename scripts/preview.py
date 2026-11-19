#!/usr/bin/env python3
"""Preview the station on loopback with fictional, in-memory jobs. Requires no Deck."""

import argparse
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Handler, MAX_SLOTS
from activity import summarize


def sample(state):
    now = time.time()
    projects = ["atlas", "estudio", "orbita", "sinal"]

    def job(n, project, label, owner, state, elapsed):
        return dict(
            id=f"{n:012x}",
            meta=dict(
                project=project, label=label, owner=owner, command=["mix", "test"]
            ),
            state=state,
            started=now - elapsed,
            created=now - elapsed - 8,
            finished=now - elapsed,
            memory=n * 193 * 1024**2,
            cancel=0,
            activity="Executando testes…",
        )

    jobs = [
        job(
            3,
            "orbita",
            "Sincronização da biblioteca",
            "Claude · revisão 18",
            "passed",
            280,
        ),
        job(4, "estudio", "Importação de áudio", "Codex · tarefa 42", "passed", 860),
        job(5, "atlas", "Índice de pesquisa", "Codex · tarefa 12", "failed", 2400),
        job(6, "sinal", "Fila de mensagens", "Claude · revisão 7", "passed", 4600),
    ]
    if state == "active":
        jobs.extend(
            [
                job(
                    1,
                    "estudio",
                    "Análise de faixas",
                    "Claude · tarefa 43",
                    "running",
                    84,
                ),
                job(
                    2, "atlas", "Busca por catálogo", "Codex · tarefa 15", "running", 42
                ),
            ]
        )
    return dict(
        jobs=jobs,
        projects=[{"name": p} for p in projects],
        alive=True,
        paused=state == "paused",
        reason="",
        slots=5,
        max_slots=MAX_SLOTS,
        project_slots=3,
        available_memory=int(7.4 * 1024**3),
        disk_free=84 * 1024**3,
        disk_reserve=10 * 1024**3, disk_admit=15 * 1024**3,
        instance="preview",
    )


class Preview(Handler):
    def activity(self, hours):
        # Demonstration history is independent of the small job list shown on screen.
        now = int(time.time())
        projects = [(p["name"], i) for i, p in enumerate(self.server.sample["projects"])]
        jobs = []
        for i, (name, _) in enumerate(projects):
            for k in range(96):
                count = (k + 3 * i) % (7 + i)
                for n in range(count if (k + i) % (3 + i) else 0):
                    created = now - (96 - k) * 900 + 31 * n
                    started = created + 4
                    jobs.append((name, created, started, started + 20 + 17 * i, "passed"))
        return summarize(hours, now, projects, jobs)

    def do_GET(self):
        if not self.valid_host():
            return self.send("Invalid host", code=403)
        path = urlsplit(self.path).path
        if path == "/api/events":
            return self.send("", code=204)
        if path == "/api/storage":
            mib = 1024**2
            projects = [
                dict(
                    name=p["name"],
                    worktrees=(i + 1) * 540 * mib,
                    cache=96 * mib,
                    repos=42 * mib,
                    jobs=7 * mib,
                )
                for i, p in enumerate(self.server.sample["projects"])
            ]
            for row in projects:
                row["total"] = sum(
                    row[k] for k in ("worktrees", "cache", "repos", "jobs")
                )
            groups = {
                key: sum(row[key] for row in projects)
                for key in ("worktrees", "cache", "repos", "jobs")
            }
            report = dict(
                projects=projects,
                groups=groups,
                total=sum(groups.values()),
                reclaimable=2400 * mib,
                count=12,
                measured=time.time(),
                plan="preview",
            )
            return self.send(
                json.dumps(dict(state="idle", report=report, outcome=None)),
                "application/json",
            )
        if path == "/api/status":
            return self.send(json.dumps({**self.server.sample, "observed_at": time.time()}), "application/json")
        if path.startswith(("/logs/", "/result/")):
            return self.send(
                "Demonstração local. Este resultado é fictício.",
                "text/plain; charset=utf-8",
            )
        super().do_GET()

    def do_POST(self):
        self.send("Prévia somente para leitura.", code=405)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--state", choices=["active", "idle", "paused"], default="active"
    )
    parser.add_argument("--port", type=int, default=4041)
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), Preview) as http:
        http.sample = sample(args.state)
        print(
            f"Prévia local · http://127.0.0.1:{http.server_port}/?screen=1", flush=True
        )
        http.serve_forever()
