#!/usr/bin/env python3
"""Check a release's immutable source identity before publishing or retrying E2E."""
import json
import os
import re
import subprocess
import sys
from urllib.request import Request, urlopen

PACKAGE = "@rudderstack/rudder-sdk-node"
REPOSITORY = "rudderlabs/rudder-sdk-node"
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)")
SHA = re.compile(r"[0-9a-f]{40}")


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def verify(event, version, sha, check_release=False):
    if not VERSION.fullmatch(version) or not SHA.fullmatch(sha):
        raise ValueError("expected an exact stable version and a full lowercase commit SHA")
    tag = f"v{version}"
    if event.get("tag_name") != tag or event.get("prerelease") or event.get("draft") or not event.get("published_at"):
        raise ValueError("expected a published, stable GitHub release with the exact version tag")
    # target_commitish is sometimes a branch name; when it is a SHA it must agree.
    target = event.get("target_commitish", "")
    if SHA.fullmatch(target) and target != sha:
        raise ValueError("release target commit differs from release tag")
    if git("rev-parse", "HEAD") != sha or git("rev-parse", f"refs/tags/{tag}^{{commit}}") != sha:
        raise ValueError("checkout, release tag and supplied source commit must agree")
    # A branch head may advance, but the released commit must remain in its history.
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/master"], check=True)
    if check_release:
        remote_tag = git("ls-remote", "origin", f"refs/tags/{tag}")
        if not remote_tag or git("rev-parse", f"refs/tags/{tag}") != remote_tag.split()[0]:
            raise ValueError("local release tag differs from remote release tag")
    with open("package.json", encoding="utf-8") as manifest:
        package = json.load(manifest)
    with open(".release-please-manifest.json", encoding="utf-8") as manifest:
        release_please = json.load(manifest)
    if package.get("name") != PACKAGE or package.get("version") != version or release_please.get(".") != version:
        raise ValueError("release tag, package version and release-please manifest disagree")
    if check_release:
        with urlopen(f"https://registry.npmjs.org/@rudderstack%2frudder-sdk-node/{version}", timeout=30) as response:
            package_metadata = json.load(response)
        if package_metadata.get("name") != PACKAGE or package_metadata.get("version") != version:
            raise ValueError("exact npm package is not available")


def main():
    try:
        version = os.environ["RELEASE_VERSION"]
        sha = os.environ["RELEASE_SHA"]
        check_release = os.environ.get("CHECK_RELEASE_API") == "true"
        if check_release:
            if not VERSION.fullmatch(version) or not SHA.fullmatch(sha):
                raise ValueError("expected an exact stable version and a full lowercase commit SHA")
            request = Request(f"https://api.github.com/repos/{REPOSITORY}/releases/tags/v{version}",
                              headers={"Accept": "application/vnd.github+json"})
            with urlopen(request, timeout=30) as response:
                event = json.load(response)
        else:
            with open(os.environ["RELEASE_EVENT_PATH"], encoding="utf-8") as release_event:
                event = json.load(release_event)["release"]
        verify(event, version, sha, check_release)
        output = os.environ.get("GITHUB_OUTPUT")
        if output:
            with open(output, "a", encoding="utf-8") as result:
                result.write(f"version={version}\nsource-sha={sha}\n")
        print(f"Verified release v{version} at {sha}")
    except (KeyError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Release identity verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
