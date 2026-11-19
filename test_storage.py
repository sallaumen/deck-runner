import contextlib
from http.client import HTTPConnection
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode
from http.server import ThreadingHTTPServer

import live
import server
import storage


class StationStorageTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch.object(server, "ROOT", self.root))
        server.db().close()
        server.register(
            dict(
                name="alpha",
                common="/tmp/alpha",
                profile="mix",
                db_user="test",
                port=5434,
            )
        )
        self.inventory = storage.Inventory(self.root, server.db)

    def add(self, job, state):
        terminal = state not in ("queued", "running")
        with contextlib.closing(server.db()) as c, c:
            c.execute(
                "INSERT INTO jobs(id,meta,state,created,finished) VALUES(?,?,?,?,?)",
                (
                    job,
                    json.dumps({"project": "alpha"}),
                    state,
                    1,
                    time.time() if terminal else None,
                ),
            )

    def git(self, *args):
        subprocess.run(["git", *map(str, args)], check=True, capture_output=True)

    def test_measured_plan_removes_only_confirmed_terminal_worktrees(self):
        repo = self.root / "repos" / "alpha.git"
        repo.parent.mkdir()
        self.git("init", "--bare", repo)
        seed = self.root / "seed"
        self.git("init", seed)
        (seed / "source").write_text("test data")
        self.git("-C", seed, "add", "source")
        self.git(
            "-C",
            seed,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "sample",
        )
        self.git("-C", seed, "push", repo, "HEAD:refs/heads/fixture")
        work = self.root / "worktrees"
        work.mkdir()
        finished, active, queued, newer = ("a" * 12, "b" * 12, "c" * 12, "d" * 12)
        for job, state in (
            (finished, "failed"),
            (active, "running"),
            (queued, "queued"),
        ):
            self.add(job, state)
            self.git("-C", repo, "worktree", "add", "--detach", work / job, "fixture")
        logs = self.root / "jobs" / finished
        logs.mkdir(parents=True)
        (logs / "output.log").write_text("keep")
        cache = self.root / "cache" / "alpha-123456789abc-unlocked-2"
        cache.mkdir(parents=True)
        (cache / "file").write_text("keep")
        report, candidates = storage.inspect(self.root, server.db)
        self.assertEqual(set(candidates), {finished})
        self.assertEqual(report["total"], sum(report["groups"].values()))
        self.assertEqual(report["projects"][0]["total"], report["total"])
        self.assertGreater(report["reclaimable"], 0)
        self.inventory.measure()
        plan = self.inventory.report["plan"]
        self.add(newer, "passed")
        self.git("-C", repo, "worktree", "add", "--detach", work / newer, "fixture")
        self.assertFalse(self.inventory.clean("old plan"))
        self.assertTrue(self.inventory.clean(plan))
        self.assertFalse(self.inventory.clean(plan))
        deadline = time.monotonic() + 6
        while self.inventory.view()["state"] != "idle" and time.monotonic() < deadline:
            time.sleep(0.04)
        self.assertEqual(self.inventory.outcome, {"removed": 1, "skipped": 0})
        self.assertFalse((work / finished).exists())
        for path in (
            work / active,
            work / queued,
            work / newer,
            cache / "file",
            logs / "output.log",
            repo,
        ):
            self.assertTrue(path.exists())
        self.assertEqual(server.jobrow(finished)["state"], "failed")

    def test_unregistered_directory_and_symlink_are_preserved(self):
        name = "f" * 12
        work = self.root / "worktrees"
        work.mkdir()
        outside = self.root / "original"
        outside.mkdir()
        (work / name).symlink_to(outside, target_is_directory=True)
        self.assertFalse(storage.remove_checkout(self.root, name, "alpha"))
        self.assertTrue(outside.exists())
        (work / name).unlink()
        (work / name).mkdir()
        self.assertFalse(storage.remove_checkout(self.root, name, "alpha"))
        self.assertTrue((work / name).is_dir())

    def test_low_disk_rejects_submissions_and_leaves_existing_job_queued(self):
        self.add("1" * 12, "queued")
        server.setting("heartbeat", time.time())
        disk = server.shutil.disk_usage(self.root)
        with patch.object(
            server.shutil,
            "disk_usage",
            return_value=disk._replace(free=storage.ADMIT_AT - 1),
        ):
            with self.assertRaisesRegex(ValueError, "recusado"):
                server.ingest(io.BytesIO(b"x"))
            self.assertIn("15 GiB", server.gate())
            self.assertIsNone(server.claim())
        with patch.object(
            server.shutil,
            "disk_usage",
            side_effect=[
                disk._replace(free=storage.ADMIT_AT),
                disk._replace(free=storage.STOP_AT),
            ],
        ):
            with self.assertRaisesRegex(ValueError, "interrompido"):
                server.ingest(io.BytesIO(b"x"))
        self.assertEqual(list((self.root / "jobs").iterdir()), [])
        self.assertEqual(server.jobrow("1" * 12)["state"], "queued")

    def test_preparation_stops_when_disk_margin_disappears(self):
        disk = server.shutil.disk_usage(self.root)
        with tempfile.TemporaryFile() as log, patch.object(
            server.shutil,
            "disk_usage",
            side_effect=[
                disk._replace(free=storage.ADMIT_AT),
                disk._replace(free=storage.STOP_AT),
            ],
        ):
            with self.assertRaises(server.DiskReserveError):
                server.prepare_command(["sleep", "30"], log, 5)

    def test_live_stream_observes_separate_writers_and_cleanup_requires_token(self):
        http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        http.inventory = self.inventory
        http.changes = live.Changes()
        stop = threading.Event()
        watcher = threading.Thread(target=http.changes.observe, args=(server.db, stop))
        watcher.start()
        with http.changes.condition:
            self.assertTrue(http.changes.condition.wait_for(lambda: http.changes.version > 0, timeout=3))
        http_thread = threading.Thread(target=http.serve_forever)
        http_thread.start()
        try:

            def post(form, origin):
                with contextlib.closing(http_client()) as conn:
                    conn.request(
                        "POST", "/storage/clean", urlencode(form), {"Origin": origin}
                    )
                    return conn.getresponse().status

            def http_client():
                return HTTPConnection("127.0.0.1", http.server_port, timeout=4)

            origin = f"http://127.0.0.1:{http.server_port}"
            self.assertEqual(post({"token": server.TOKEN}, "http://elsewhere"), 403)
            self.assertEqual(post({"token": "wrong"}, origin), 403)
            self.assertEqual(
                post({"token": server.TOKEN, "plan": "stale"}, origin), 409
            )
            with contextlib.closing(http_client()) as conn:
                conn.request("GET", "/api/events")
                response = conn.getresponse()
                self.assertEqual(
                    response.getheader("Content-Type"), "text/event-stream"
                )

                def next_version():
                    line = response.readline()
                    self.assertTrue(line.startswith(b"id:"))
                    seq = int(line.split()[1])
                    self.assertEqual(response.readline(), b"event: queue\n")
                    response.readline()
                    response.readline()
                    return seq

                first = next_version()
                self.add("2" * 12, "queued")
                self.assertGreater(next_version(), first)
                with http.changes.condition:
                    before = http.changes.version
                server.setting("heartbeat", time.time())
                time.sleep(0.75)
                self.assertEqual(http.changes.version, before)
        finally:
            stop.set()
            watcher.join(3)
            http.shutdown()
            http.server_close()
            http_thread.join(3)
