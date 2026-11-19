import concurrent.futures
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

import activity
import client
import server


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = patch.object(server, "ROOT", Path(self.temp.name))
        self.root.start()
        space = server.shutil.disk_usage(self.temp.name)._replace(free=64 * server.GIB)
        self.enterContext(patch.object(server.shutil, "disk_usage", return_value=space))
        server.db().close()
        server.register(
            dict(
                name="catalogue",
                common="/repos/board",
                profile="mix",
                db_user="board",
                port=5434,
            )
        )
        self.memory = patch.object(
            server, "available_memory", return_value=10 * server.GIB
        )
        self.memory.start()

    def tearDown(self):
        self.memory.stop()
        self.root.stop()
        self.temp.cleanup()

    def add(self, job, created, project="catalogue"):
        with contextlib.closing(server.db()) as c, c:
            c.execute(
                "INSERT INTO jobs(id,meta,state,created) VALUES(?,?,?,?)",
                (job, json.dumps({"project": project}), "queued", created),
            )

    def test_global_and_project_limits_are_atomic_and_work_conserving(self):
        for i, project in enumerate(["catalogue"] * 6 + ["second"] * 2):
            self.add(f"{i:012x}", i, project)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            claims = list(pool.map(lambda _: server.claim(), range(8)))
        active = [server.jobrow(job) for job in claims if job]
        self.assertEqual(len(active), 5)
        lanes = [
            json.loads(j["meta"])["lane"]
            for j in active
            if json.loads(j["meta"])["project"] == "catalogue"
        ]
        self.assertEqual(sorted(lanes), [0, 1, 2])
        self.assertIsNone(server.claim())
        server.update("0" * 12, state="passed", finished=time.time())
        self.assertEqual(server.claim(), f"{3:012x}")

    def test_higher_limits_and_lowering_during_work(self):
        def change(total, per_project, old_total, old_project):
            return server.change_limits({key: [str(n)] for key, n in (
                ("slots", total), ("project_slots", per_project),
                ("previous_slots", old_total), ("previous_project_slots", old_project),
            )})[0]
        for i, project in enumerate(["catalogue"] * 7 + ["second"] * 3):
            self.add(f"{i:012x}", i, project)
        with (
            patch.object(server, "pool_budget", return_value=10240),
            patch.object(server, "available_memory", return_value=13 * server.GIB),
        ):
            self.assertTrue(change(8, 5, 5, 3))
            with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
                claimed = [job for job in pool.map(lambda _: server.claim(), range(10)) if job]
            self.assertEqual(len(claimed), 8)
            self.assertEqual(sorted(json.loads(server.jobrow(j)["meta"])["lane"]
                                    for j in claimed if int(j, 16) < 7), list(range(5)))
            self.assertTrue(change(3, 2, 8, 5))
            self.assertIn("limite de 3", server.status()["reason"])
            self.assertIsNone(server.claim())
            for i in (0, 1, 2, 7, 8, 9):
                server.update(f"{i:012x}", state="passed", finished=time.time())
            self.assertIsNone(server.claim())
            self.assertIn("por projeto", server.status()["reason"])
            server.update(f"{3:012x}", state="passed", finished=time.time())
            self.assertEqual(server.claim(), f"{5:012x}")
            self.assertEqual(json.loads(server.jobrow(f"{5:012x}")["meta"])["lane"], 0)
            self.assertEqual(server.jobrow(f"{4:012x}")["state"], "running")

    def test_pool_tracks_slots_and_respects_kernel_and_desktop_limits(self):
        root = Path(self.temp.name)
        parent = root / "parent"
        leaf = parent / "tests"
        leaf.mkdir(parents=True)
        (parent / "memory.max").write_text("max")
        with patch.object(server, "CGROUP_ROOT", root), patch.object(server, "DECK_SLICE", leaf):
            self.assertEqual(server.pool_budget(8), 7680)
            (leaf / "memory.max").write_text(str(12 * server.GIB))
            self.assertEqual(server.pool_budget(5), 7680)
            self.assertEqual(server.pool_budget(8), 10240)
            (parent / "memory.max").write_text(str(9 * server.GIB))
            self.assertEqual(server.pool_budget(8), 8704)
            with patch.object(server, "available_memory", return_value=3 * server.GIB):
                self.assertEqual(server.capacity_bytes([], server.pool_budget(8)), 1536 * server.MIB)

    def test_eight_configured_still_waits_for_real_memory(self):
        server.setting("slots", "[8, 5]")
        for i in range(9):
            self.add(f"{i:012x}", i, "catalogue" if i % 2 else "second")
        with (
            patch.object(server, "available_memory", return_value=9 * server.GIB),
            patch.object(server, "pool_budget", return_value=10240),
        ):
            claimed = [server.claim() for _ in range(8)]
            self.assertEqual(len(list(filter(None, claimed))), 6)
            self.assertIn("memória", server.status()["reason"])

    def test_simultaneous_admission_reserves_unused_memory(self):
        self.add("a" * 12, 1)
        self.add("b" * 12, 2)
        with patch.object(server, "available_memory", return_value=3 * server.GIB):
            self.assertEqual(server.claim(), "a" * 12)
            self.assertIsNone(server.claim())

    def test_activity_uses_full_history_and_splits_worker_time_at_bucket_edges(self):
        end = 24 * 3600
        start = end - 6 * 3600
        width = 900
        with contextlib.closing(server.db()) as c, c:
            def insert(name, state, created, started=None, finished=None):
                c.execute("INSERT INTO jobs(id,meta,state,created,started,finished) VALUES(hex(randomblob(6)), ?, ?, ?, ?, ?)",
                          (json.dumps({"project": name}), state, created, started, finished))

            for _ in range(115):
                insert("catalogue", "passed", start, start, start + 1)
            # Submitted yesterday, but its last 70 seconds used a slot in this window.
            insert("catalogue", "passed", start - 3600, start - 40, start + 70)
            insert("catalogue", "failed", start + 800, start + 899, start + 925)
            insert("catalogue", "running", end - 80, end - 30)
            insert("catalogue", "cancelled", start + width)
            insert("catalogue", "queued", end)
            insert("catalogue", "passed", start - 999, start - 800, start)
            insert("archived", "passed", start + 100, start + 101, end - 1)
            result = activity.from_database(c, 6, end)
        self.assertEqual(len(result["projects"]), 1)
        row = result["projects"][0]
        self.assertEqual(result["bucket_seconds"], width)
        self.assertEqual(len(row["requests"]), 24)
        self.assertEqual(server.status()["projects"][0]["color"], row["color"])
        self.assertEqual(row["requests"][:2], [116, 1])
        self.assertEqual(sum(row["requests"]), 118)
        self.assertEqual(row["seconds"][:2], [186, 25])
        self.assertEqual(row["seconds"][-1], 30)
        self.assertEqual(sum(row["seconds"]), 241)

    def test_status_keeps_the_last_result_of_a_quiet_project(self):
        with contextlib.closing(server.db()) as c, c:
            c.executemany(
                "INSERT INTO jobs(id,meta,state,created,finished) VALUES(?,?,'passed',?,?)",
                [
                    (
                        f"{i:012x}",
                        json.dumps({"project": "second" if i else "catalogue"}),
                        i,
                        i,
                    )
                    for i in range(105)
                ],
            )
        results = server.status()["jobs"]
        self.assertEqual(len(results), 101)
        self.assertTrue(any(j["id"] == "0" * 12 for j in results))

    def test_registry_updates_and_removal_preserve_identity_and_pending_work(self):
        p = server.projects()["catalogue"]
        with self.assertRaises(ValueError):
            server.register({**p, "common": "/elsewhere", "update": True})
        self.add("a" * 12, 1)
        with self.assertRaises(ValueError):
            server.remove_project(p["name"])
        server.cancel("a" * 12)
        server.remove_project(p["name"])
        self.assertNotIn(p["name"], server.projects())
        self.assertEqual(server.jobrow("a" * 12)["state"], "cancelled")
        server.register(p)
        server.register({**p, "port": 5435, "update": True})
        self.assertEqual(server.projects()[p["name"]]["port"], 5435)

    def test_mix_image_and_standard_database_are_scoped_to_the_registration(self):
        p = dict(
            server.projects()["catalogue"],
            name="audio-library",
            common="/repos/audio-library",
            image="localhost/deck-audio-library:v1",
            no_test_partition=True,
        )
        with patch.object(server, "run") as run:
            server.register(p)
            run.assert_called_once_with(["podman", "image", "exists", p["image"]])
        self.assertEqual(server.projects()["audio-library"], p)
        self.assertNotIn("no_test_partition", server.projects()["catalogue"])
        with self.assertRaises(ValueError):
            server.register({**p, "profile": "python"})

    def test_cancel_queued_and_running(self):
        self.add("a" * 12, 1)
        self.add("b" * 12, 2)
        server.cancel("a" * 12)
        self.assertEqual(server.jobrow("a" * 12)["state"], "cancelled")
        self.assertEqual(server.claim(), "b" * 12)
        server.cancel("b" * 12)
        self.assertEqual(server.jobrow("b" * 12)["cancel"], 1)
        self.assertIsNone(server.claim())

    def test_pause_and_resource_admission(self):
        server.setting("paused", "1")
        self.add("a" * 12, 1)
        self.assertIsNone(server.claim())
        self.assertIn("Pausado", server.gate())
        server.setting("paused", "0")
        with patch.object(server, "available_memory", return_value=1):
            self.assertIn("memória", server.gate())

    def test_unsafe_archive_is_rejected(self):
        server.setting("heartbeat", time.time())
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as t:
            info = tarfile.TarInfo("../../escape")
            info.size = 1
            t.addfile(info, io.BytesIO(b"x"))
        stream.seek(0)
        with self.assertRaises(ValueError):
            server.ingest(stream)
        self.assertEqual(list((server.ROOT / "jobs").iterdir()), [])

    def test_metadata_rejects_unprepared_project_and_shell(self):
        m = dict(
            project="catalogue",
            owner="agent",
            label="task",
            source_commit="a" * 40,
            snapshot_commit="b" * 40,
            tree="c" * 40,
            command=["mix", "test"],
            timeout=60,
        )
        server.validate_meta(m)
        with self.assertRaises(ValueError):
            server.validate_meta({**m, "project": "other"})
        with self.assertRaises(ValueError):
            server.validate_meta({**m, "command": ["sh", "-c", "anything"]})


class SnapshotTest(unittest.TestCase):
    def test_dirty_snapshot_and_source_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            client.git(repo, "init", "-q")
            (repo / "keep").write_text("before")
            (repo / "delete").write_text("gone")
            (repo / ".gitignore").write_text(".env.local\n")
            client.git(repo, "add", ".")
            client.git(
                repo,
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "base",
            )
            head = client.git(repo, "rev-parse", "HEAD")
            (repo / "keep").write_text("after")
            (repo / "delete").unlink()
            (repo / "new").write_text("included")
            (repo / ".env.local").write_text("not transported")
            (repo / ".idea").mkdir()
            (repo / ".idea" / "workspace.xml").write_text("local only")
            before = client.git(repo, "status", "--porcelain")
            out = root / "out"
            out.mkdir()
            package, meta = client.snapshot(
                repo, out, "agent", "dirty", ["mix", "test"], 60, "catalogue"
            )
            clone = root / "verify"
            subprocess.run(
                ["git", "clone", "-q", str(out / "snapshot.bundle"), str(clone)],
                check=True,
            )
            self.assertEqual((clone / "keep").read_text(), "after")
            self.assertEqual((clone / "new").read_text(), "included")
            self.assertFalse((clone / "delete").exists())
            self.assertFalse((clone / ".env.local").exists())
            self.assertFalse((clone / ".idea").exists())
            self.assertEqual(before, client.git(repo, "status", "--porcelain"))
            self.assertEqual(head, client.git(repo, "rev-parse", "HEAD"))
            self.assertEqual(
                client.git(clone, "rev-list", "--count", "HEAD").strip(), b"1"
            )
            self.assertEqual(
                meta["tree"],
                client.git(clone, "rev-parse", "HEAD^{tree}").decode().strip(),
            )


if __name__ == "__main__":
    unittest.main()
