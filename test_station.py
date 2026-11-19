import contextlib
import http.client
import io
import json
import subprocess
import tempfile
import threading
import unittest
import urllib.parse
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import display
import server
import settings
from mac import link_status


class HttpTest(unittest.TestCase):
    def setUp(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(server, "ROOT", Path(tmp)))
        self.enterContext(
            patch.object(server, "available_memory", return_value=9 * server.GIB)
        )
        self.http = self.serve(server.Handler)

    def serve(self, handler):
        http = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.addCleanup(http.server_close)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(http.shutdown)
        return http

    def request(self, path="/", method="GET", body=None, headers=None, station=None):
        with contextlib.closing(
            http.client.HTTPConnection(
                "127.0.0.1", (station or self.http).server_port, timeout=2
            )
        ) as c:
            c.request(method, path, body, headers or {})
            r = c.getresponse()
            return r.status, dict(r.getheaders()), r.read()

    def test_assets_and_status_are_served_only_on_expected_host(self):
        for url in [
            "/",
            "/assets/dashboard.css",
            "/assets/dashboard.js",
            "/assets/motion.js",
            "/assets/motion.css",
            "/assets/pilot.png",
            "/assets/controller.js",
            "/assets/activity.js",
            "/assets/limits.js",
            "/assets/icon.svg",
        ]:
            code, headers, body = self.request(url)
            self.assertEqual(code, 200)
            self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
            self.assertTrue(body)
        self.assertEqual(
            self.request(headers={"Host": "not-the-station.invalid"})[0], 403
        )
        self.assertEqual(json.loads(self.request("/api/status")[2])["slots"], 5)

    def test_activity_is_available_with_empty_history_and_rejects_unknown_periods(self):
        for query, seconds in [("", 900), ("?hours=24", 3600)]:
            code, _, raw = self.request("/api/activity" + query)
            self.assertEqual(code, 200)
            view = json.loads(raw)
            self.assertEqual(view["bucket_seconds"], seconds)
            self.assertEqual(view["end"] - view["start"], 24 * seconds)
            self.assertEqual(view["projects"], [])
        for query in ["?hours=0", "?hours=", "?hours=6&hours=24"]:
            self.assertEqual(self.request("/api/activity" + query)[0], 400)

    def test_boot_signal_waits_for_steam_without_blocking_the_queue(self):
        with patch.object(server, "remote_play_ready", return_value=False):
            code, headers, _ = self.request("/api/boot")
            self.assertEqual((code, headers["Cache-Control"]), (503, "no-store"))
            self.assertEqual(self.request("/api/status")[0], 200)
        with patch.object(server, "remote_play_ready", return_value=True), patch.object(
            Path, "read_text", return_value="be3a0602-c41e-4e67-ad02-522bf7bbd703\n"
        ):
            code, _, boot = self.request("/api/boot")
            self.assertEqual((code, boot), (200, b"be3a0602-c41e-4e67-ad02-522bf7bbd703"))

    def test_limits_are_atomic_persistent_and_protected_against_stale_edits(self):
        headers = {"Origin": f"http://127.0.0.1:{self.http.server_port}"}
        form = dict(token=server.TOKEN, slots="8", project_slots="5",
                    previous_slots="5", previous_project_slots="3")
        def post(**changes):
            return self.request("/limits", "POST", urllib.parse.urlencode({**form, **changes}), headers)
        self.assertEqual(self.request("/limits", "POST", urllib.parse.urlencode(form))[0], 403)
        self.assertEqual(post(token="wrong")[0], 403)
        for invalid in ({"slots": "0"}, {"slots": "33"}, {"project_slots": "9"},
                        {"previous_slots": ""}, {"slots": "8.5"}):
            self.assertEqual(post(**invalid)[0], 400)
        self.assertEqual(post()[0], 200)
        self.assertEqual(post()[0], 200)  # retry after a lost confirmation
        code, _, body = post(project_slots="4")
        self.assertEqual(code, 409)
        self.assertEqual(json.loads(body), {"slots": 8, "project_slots": 5})
        current = json.loads(self.request("/api/status")[2])
        self.assertEqual((current["slots"], current["project_slots"]), (8, 5))

    def test_pause_and_resume_require_same_origin_and_valid_action_token(self):
        form = urllib.parse.urlencode({"token": server.TOKEN})
        headers = {"Origin": f"http://127.0.0.1:{self.http.server_port}"}
        self.assertEqual(self.request("/pause", "POST", form)[0], 403)
        self.assertEqual(self.request("/pause", "POST", "token=wrong", headers)[0], 403)
        for route, flag in [("/pause", True), ("/resume", False)]:
            self.assertEqual(self.request(route, "POST", form, headers)[0], 303)
            self.assertIs(json.loads(self.request("/api/status")[2])["paused"], flag)

    def test_close_only_stops_display_and_requires_same_origin_and_token(self):
        headers = {"Origin": f"http://127.0.0.1:{self.http.server_port}"}
        form = urllib.parse.urlencode({"token": server.TOKEN})
        with patch.object(server.subprocess, "run") as stop:
            self.assertEqual(self.request("/display/close", "GET")[0], 404)
            self.assertEqual(self.request("/display/close", "POST", form)[0], 403)
            self.assertEqual(self.request("/display/close", "POST", "token=bad", headers)[0], 403)
            stop.assert_not_called()
            self.assertEqual(self.request("/display/close", "POST", form, headers)[0], 204)
            stop.assert_called_once_with(
                ["systemctl", "--user", "stop", "--no-block", "deck-runner-display.service"],
                check=True, timeout=5,
            )
            stop.side_effect = OSError("systemd unavailable")
            self.assertEqual(self.request("/display/close", "POST", form, headers)[0], 503)

    def test_old_bookmarks_keep_the_path_on_the_new_station(self):
        redirect = self.serve(server.LegacyRedirect)
        code, headers, _ = self.request("/?screen=1", station=redirect)
        self.assertEqual(
            (code, headers["Location"]),
            (302, f"http://127.0.0.1:{settings.PORT}/?screen=1"),
        )

    def test_host_configuration(self):
        self.assertEqual(
            settings.valid_host("deck@steamdeck.local"), "deck@steamdeck.local"
        )
        for value in ["", "-F", "with space", "ssh://host"]:
            with self.assertRaises(ValueError):
                settings.valid_host(value)


class RemotePlayTest(unittest.TestCase):
    def test_only_the_steam_process_listening_on_the_host_port_is_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pid = root / "steam.pid"
            (root / "net").mkdir()
            fds = root / "123" / "fd"
            fds.mkdir(parents=True)
            self.assertFalse(server.remote_play_ready(root, pid))
            pid.write_text("123\n")
            fd = fds / "5"
            fd.symlink_to("socket:[101]")
            for protocol, port, state, inode, ready in [
                ("tcp", "699C", "01", "101", False),  # Connected, not listening.
                ("tcp", "699D", "0A", "101", False),
                ("tcp", "699C", "0A", "202", False),  # A different process.
                ("tcp", "699C", "0A", "101", True),
                ("tcp6", "699C", "0A", "101", True),
            ]:
                with self.subTest(protocol=protocol, port=port, state=state, inode=inode):
                    table = root / "net" / protocol
                    table.write_text(f"header\n0: 00000000:{port} 00000000:0000 {state} 0:0 0:0 0 1000 0 {inode}\n")
                    self.assertEqual(server.remote_play_ready(root, pid), ready)
                    table.unlink()


class VideoStatusTest(unittest.TestCase):
    def test_signed_probe_recognizes_both_video_titles_and_the_home_screen(self):
        def respond(args, **_kwargs):
            Path(args[args.index("--stdout") + 1]).write_text(
                f"accessibility=true boot=true window={title}\n"
            )
            self.assertEqual(args[-1], "--status")
            # LaunchServices can lose its wait handle after a short-lived probe exits.
            return subprocess.CompletedProcess(args, 1)

        with patch.object(subprocess, "run", side_effect=respond):
            for title, streaming in [
                ("Personal document [Streaming]", True), ("Streaming Client", True), ("", False)
            ]:
                with self.subTest(title=title):
                    self.assertEqual(link_status.probe(Path("/example.app")), (True, True, streaming))

    def test_open_close_and_reopen_are_read_only(self):
        self.enterContext(patch.object(link_status.sys, "platform", "darwin"))
        self.enterContext(patch.object(Path, "is_dir", return_value=True))
        for opened, streaming, access, title in (
            (False, False, True, "Steam Link fechado"),
            (True, False, True, "Steam Link aberto"),
            (True, True, True, "Transmitindo"),
            (True, False, False, "autorize Acessibilidade"),
        ):
            with self.subTest(title=title):
                commands = [
                    subprocess.CompletedProcess([], 0, stdout="\tstate = running\n"),
                    subprocess.CompletedProcess([], 0 if opened else 1),
                ]
                with (
                    patch.object(link_status, "probe", return_value=(access, True, streaming)),
                    patch.object(subprocess, "run", side_effect=commands) as run,
                    contextlib.redirect_stdout(io.StringIO()) as out,
                ):
                    code = link_status.diagnose()
                self.assertIn(title, out.getvalue().splitlines()[0])
                self.assertEqual(code, 0 if access else 1)
                self.assertEqual([c.args[0][0] for c in run.call_args_list], ["launchctl", "pgrep"])


class DisplayTest(unittest.TestCase):
    def test_supervision_only_matches_the_main_browser_of_the_station(self):
        main = [
            b"/app/extra/chrome",
            display.PROFILE_ARG.encode(),
            ("--app=" + display.URL).encode(),
        ]
        self.assertTrue(display.is_display(main))
        self.assertFalse(display.is_display(main + [b"--type=renderer"]))
        self.assertFalse(
            display.is_display([main[0], b"--user-data-dir=/personal", main[2]])
        )
        self.assertFalse(
            display.is_display([main[0], main[1], b"--app=https://example.org/"])
        )
