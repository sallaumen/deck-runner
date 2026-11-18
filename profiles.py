"""Trusted test profiles shared by the Mac and Deck."""

import re

MIB = 1024**2
GLOBAL_LIMIT = 5
PROJECT_LIMIT = 3
POOL_MIB = 7680
DESKTOP_MIB = 1536
DEFAULT_MIB = 1280
COMMANDS = {
    "custom": [],
    "mix": ["mix", "test"],
    "node": ["npm", "test"],
    "python": ["python3", "-m", "unittest", "discover"],
}


def validate_project(p):
    for key in ("name", "profile", "common", "db_user"):
        if not isinstance(p.get(key), str):
            raise ValueError("Invalid project metadata")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", p["name"]):
        raise ValueError(
            "Use a project name with letters, numbers, dots, underscores or hyphens"
        )
    if (
        p["profile"] not in COMMANDS
        or not p["common"].startswith("/")
        or len(p["common"]) > 2048
    ):
        raise ValueError("Invalid runtime or local Git directory")
    if not re.fullmatch("[a-z][a-z0-9_]{0,30}", p["db_user"]):
        raise ValueError("Use a simple local test role name")
    if type(p.get("port")) is not int or not 1024 <= p["port"] <= 65535:
        raise ValueError("Invalid test database port")
    if "image" in p or p["profile"] == "custom":
        image = p.get("image")
        if (
            p["profile"] not in ("mix", "custom")
            or not isinstance(image, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9._/:@-]{0,199}", image)
        ):
            raise ValueError(
                "Use an installed OCI image name with a mix or custom profile"
            )
    if "no_test_partition" in p and (
        p["profile"] != "mix" or type(p["no_test_partition"]) is not bool
    ):
        raise ValueError(
            "The test partition option is supported only by the mix profile"
        )
    if p["profile"] == "custom":
        if not isinstance(p.get("test"), list) or not p["test"]:
            raise ValueError("Custom profiles require the test command as a JSON array")
        check_command(p["profile"], p["test"], p["test"])


def check_command(profile, cmd, prefix=None):
    if (
        not isinstance(cmd, list)
        or not cmd
        or any(not isinstance(x, str) or len(x) > 1000 or "\0" in x for x in cmd)
    ):
        raise ValueError("Invalid test arguments")
    if profile == "custom":
        allowed = bool(prefix) and cmd[: len(prefix)] == prefix
    elif profile == "mix":
        allowed = (
            len(cmd) >= 2
            and cmd[0] == "mix"
            and cmd[1]
            in ("test", "lint", "gate", "compile", "format", "credo", "sobelow")
        )
    elif profile == "node":
        allowed = cmd[:2] in (["npm", "test"], ["node", "--test"])
    else:
        allowed = cmd[:3] == ["python3", "-m", "unittest"]
    if not allowed:
        raise ValueError(f"Command does not match the {profile} test profile")
