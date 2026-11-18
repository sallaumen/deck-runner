"""Discover primary Git checkouts without traversing projects or developer worktrees."""

from pathlib import Path
import re
import subprocess

from profiles import validate_project


def common_dir(repo):
    return Path(
        subprocess.check_output(
            [
                "git",
                "-C",
                str(repo),
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    ).resolve()


def profile_for(repo):
    if (repo / "mix.exs").is_file():
        return "mix"
    if (repo / "package.json").is_file():
        return "node"
    if any(
        (repo / name).exists()
        for name in ("pyproject.toml", "setup.py", "requirements.txt", "tests")
    ):
        return "python"
    return None


def discover(root):
    found = []
    for path in sorted(root.expanduser().iterdir()):
        if path.is_symlink() or not (path / ".git").is_dir():
            continue
        found.append(dict(path=str(path), name=path.name, profile=profile_for(path)))
    return found


def registration(
    repo,
    name,
    profile,
    port,
    db_user,
    image=None,
    test=None,
    *,
    no_test_partition=False,
):
    repo = Path(repo).expanduser().resolve()
    common = common_dir(repo)
    if common.name != ".git" or not common.parent.is_relative_to(
        (Path.home() / "projects").resolve()
    ):
        raise ValueError(
            "Escolha um repositório Git cuja pasta principal esteja em ~/projects."
        )
    project = dict(
        common=str(common),
        name=name
        or re.sub(r"[^a-z0-9._-]+", "-", common.parent.name.lower()).strip("-"),
        profile=profile or profile_for(repo),
        port=port,
        db_user=db_user,
    )
    if image:
        project["image"] = image
    if project["profile"] == "custom":
        project["test"] = test
    if no_test_partition:
        project["no_test_partition"] = True
    if not project["profile"]:
        raise ValueError(
            "Stack sem perfil automático. Use add --profile custom --image IMAGEM --test COMANDO_JSON."
        )
    validate_project(project)
    return project
