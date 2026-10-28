#!/usr/bin/env python3
"""Trusted, credential-free decision logic for Node PR and release E2E gates."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
from urllib.request import Request, urlopen

REPOSITORY = "rudderlabs/rudder-sdk-node"
PACKAGE = "@rudderstack/rudder-sdk-node"
SHA = re.compile(r"[0-9a-f]{40}\Z")
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")


def github(path, token):
    request = Request(f"https://api.github.com/repos/{REPOSITORY}{path}", headers={
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
        "Authorization": f"Bearer {token}",
    })
    with urlopen(request, timeout=30) as response:
        return json.load(response)


def merge_sha(pr):
    sha = pr.get("merge_commit_sha", "")
    if (pr.get("state") != "open" or pr.get("base", {}).get("ref") != "master"
            or not isinstance(sha, str) or not SHA.fullmatch(sha)):
        raise ValueError("PR has no current supported merge candidate")
    return sha


def pr_decision(pr, event_sha, head_repo, author, result, validated_sha):
    current = merge_sha(pr)
    if current != event_sha:
        raise ValueError("PR merge SHA changed since event; rerun for the new candidate")
    if head_repo != REPOSITORY or author == "dependabot[bot]":
        if result != "skipped":
            raise ValueError("ineligible PR unexpectedly ran privileged validation")
        return "success", "No-secret validation intentionally skipped: fork or Dependabot PR"
    if pr.get("head", {}).get("repo", {}).get("full_name") != REPOSITORY:
        raise ValueError("PR head repository changed")
    if result != "success" or validated_sha != current:
        raise ValueError(f"eligible PR requires successful validation of {current}; got {result}")
    return "success", f"Isolated reliability and delivery passed for {current}"


def select_pr(env, api=github):
    number = env["PR_NUMBER"]
    if not re.fullmatch(r"[1-9][0-9]*", number) or env.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("unsupported PR or repository")
    pr = api(f"/pulls/{number}", env["GH_TOKEN"])
    if pr.get("number") != int(number) or pr.get("head", {}).get("repo", {}).get("full_name") != REPOSITORY:
        raise ValueError("not a current same-repository PR")
    sha = merge_sha(pr)
    if sha != env["EVENT_SHA"]:
        raise ValueError("PR merge SHA changed since event")
    return sha


def completed_pr(env, api=github):
    """Recheck the PR after the central run completed, not only before dispatch."""
    number = env["PR_NUMBER"]
    if (not re.fullmatch(r"[1-9][0-9]*", number)
            or not re.fullmatch(r"[1-9][0-9]*", env["VALIDATION_RUN"]) or env.get("GITHUB_REPOSITORY") != REPOSITORY):
        raise ValueError("unsupported PR or validation run")
    pr = api(f"/pulls/{number}", env["GH_TOKEN"])
    if pr.get("number") != int(number) or merge_sha(pr) != env["EVENT_SHA"] or env["VALIDATED_SHA"] != env["EVENT_SHA"]:
        raise ValueError("completed validation does not match the current PR merge SHA")
    return env["VALIDATED_SHA"]


def pr_gate(env, api=github, post=None):
    number = env["PR_NUMBER"]
    if not re.fullmatch(r"[1-9][0-9]*", number) or env.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("unsupported PR or repository")
    pr = api(f"/pulls/{number}", env["GH_TOKEN"])
    if pr.get("number") != int(number):
        raise ValueError("PR number changed")
    event_sha = env["EVENT_SHA"]
    if not SHA.fullmatch(event_sha):
        raise ValueError("event has no merge SHA")
    # An obsolete run must not overwrite the current candidate's status.
    if merge_sha(pr) != event_sha:
        raise ValueError("PR merge SHA changed since event; rerun for the new candidate")
    try:
        state, description = pr_decision(pr, event_sha, env["HEAD_REPO"], env["PR_AUTHOR"],
                                         env["VALIDATION_RESULT"], env["VALIDATED_SHA"])
    except ValueError as error:
        state, description = "failure", str(error)
    payload = json.dumps({"state": state, "context": "Node Candidate E2E",
                          "description": description[:140],
                          "target_url": env["VALIDATION_RUN"] or env["GITHUB_SERVER_URL"] + "/" + REPOSITORY + "/actions"}).encode()
    if post is None:
        request = Request(f"https://api.github.com/repos/{REPOSITORY}/statuses/{event_sha}", payload, {
            "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
            "Authorization": f"Bearer {env['GH_TOKEN']}", "Content-Type": "application/json",
        }, method="POST")
        with urlopen(request, timeout=30):
            pass
    else:
        post(event_sha, json.loads(payload))
    if state != "success":
        raise ValueError(description)
    return description


def release_identity(tag, release_tag, commit, master, version):
    if (not isinstance(commit, str) or not SHA.fullmatch(commit) or not isinstance(master, str)
            or not SHA.fullmatch(master) or commit != master
            or not VERSION.fullmatch(version) or tag != f"v{version}" or release_tag != tag):
        raise ValueError("release tag, stable package version, commit and current master must agree")


def release_gate(env, root=Path("."), api=github):
    if env.get("GITHUB_REPOSITORY") != REPOSITORY or env.get("GITHUB_EVENT_NAME") != "release":
        raise ValueError("only a published release may publish")
    tag = env["GITHUB_REF_NAME"]
    version = json.loads((root / "package.json").read_text())["version"]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    # Resolve tag from the remote instead of assuming an event SHA is the peeled
    # commit (annotated tags can have a different object ID).
    refs = subprocess.check_output(["git", "ls-remote", "--tags", "origin", f"refs/tags/{tag}",
                                    f"refs/tags/{tag}^{{}}"], cwd=root, text=True)
    tag_commits = dict(line.split() for line in refs.splitlines())
    tagged = tag_commits.get(f"refs/tags/{tag}^{{}}", tag_commits.get(f"refs/tags/{tag}"))
    master = api("/git/ref/heads/master", env["GH_TOKEN"])["object"]["sha"]
    release_identity(tag, env["RELEASE_TAG"], commit, master, version)
    if (tagged != commit or env.get("RELEASE_DRAFT") != "false"
            or env.get("RELEASE_PRERELEASE") != "false"
            or env.get("GITHUB_REF") != f"refs/tags/{tag}"):
        raise ValueError("release is not a published stable tag of the tested commit")
    return commit, version


def pack_file(directory, result):
    packages = json.loads(result)
    if (not isinstance(packages, list) or len(packages) != 1
            or not isinstance(packages[0], dict)):
        raise ValueError("npm pack must produce exactly one artifact")
    filename = packages[0].get("filename")
    if (not isinstance(filename, str) or not re.fullmatch(r"[A-Za-z0-9._-]+\.tgz", filename)
            or not (directory / filename).is_file()):
        raise ValueError("npm pack returned an invalid filename")
    return directory / filename


def artifact(path, version, expected=None):
    if not VERSION.fullmatch(version) or not path.is_file() or path.is_symlink():
        raise ValueError("invalid local npm tarball")
    with tarfile.open(path, "r:gz") as packed:
        manifest = json.load(packed.extractfile("package/package.json"))
    if manifest.get("name") != PACKAGE or manifest.get("version") != version:
        raise ValueError("packed package name or version differs from release")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if expected is not None and digest != expected:
        raise ValueError("packed npm artifact changed before publication")
    return digest


if __name__ == "__main__":
    try:
        mode = sys.argv[1]
        if mode == "pr":
            print(pr_gate(os.environ))
        elif mode == "select":
            sha = select_pr(os.environ)
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"sha={sha}\n")
        elif mode == "completed":
            sha = completed_pr(os.environ)
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"sha={sha}\n")
            print(sha)
        elif mode == "release":
            sha, version = release_gate(os.environ, root=Path(sys.argv[2]) if len(sys.argv) > 2 else Path("."))
            if os.environ.get("GITHUB_OUTPUT"):
                with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                    output.write(f"sha={sha}\nversion={version}\n")
            print(f"Release identity verified: {sha}, v{version}")
        elif mode == "pack-file":
            print(pack_file(Path(sys.argv[2]), sys.argv[3]))
        elif mode == "artifact":
            path = Path(sys.argv[2])
            digest = artifact(path, sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None)
            print(digest)
        else:
            raise ValueError("expected pr, select, completed, release, pack-file, or artifact")
    except (OSError, ValueError, KeyError, IndexError, subprocess.CalledProcessError) as error:
        print(f"Node candidate gate failed: {error}", file=sys.stderr)
        sys.exit(1)
