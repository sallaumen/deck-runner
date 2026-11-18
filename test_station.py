import contextlib
import http.client
import json
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
            "/assets/controller.js",
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
