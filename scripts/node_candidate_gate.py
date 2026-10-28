#!/usr/bin/env python3
"""Trusted decision logic for isolated Node PR candidate validation."""
import json
import os
import re
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

REPOSITORY = "rudderlabs/rudder-sdk-node"
SHA = re.compile(r"[0-9a-f]{40}\Z")


def github(path, token):
    request = Request(f"https://api.github.com/repos/{REPOSITORY}{path}", headers={
        "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
        "Authorization": f"Bearer {token}",
    })
    with urlopen(request, timeout=30) as response:
        return json.load(response)



def read_pr(number, token, api):
    pr = dict(api(f"/pulls/{number}", token))
    # Newer PR API responses can omit merge_commit_sha. Read the synthetic ref directly.
    pr["merge_commit_sha"] = None
    if pr.get("state") == "open" and pr.get("mergeable", True) is True:
        try:
            reference = api(f"/git/ref/pull/{number}/merge", token)
        except HTTPError as error:
            if error.code != 404:
                raise
        else:
            if reference.get("object", {}).get("type") == "commit":
                pr["merge_commit_sha"] = reference["object"].get("sha")
    return pr


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


def completed_pr(env, api=github):
    """Recheck the PR after the central run completed, not only before dispatch."""
    number = env["PR_NUMBER"]
    if (not re.fullmatch(r"[1-9][0-9]*", number)
            or not re.fullmatch(r"[1-9][0-9]*", env["VALIDATION_RUN"]) or env.get("GITHUB_REPOSITORY") != REPOSITORY):
        raise ValueError("unsupported PR or validation run")
    pr = read_pr(number, env["GH_TOKEN"], api)
    if pr.get("number") != int(number) or merge_sha(pr) != env["EVENT_SHA"] or env["VALIDATED_SHA"] != env["EVENT_SHA"]:
        raise ValueError("completed validation does not match the current PR merge SHA")
    return env["VALIDATED_SHA"]


def pr_gate(env, api=github, post=None):
    number = env["PR_NUMBER"]
    if not re.fullmatch(r"[1-9][0-9]*", number) or env.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("unsupported PR or repository")
    pr = read_pr(number, env["GH_TOKEN"], api)
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


def candidates(env, api=github):
    if env.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("unsupported repository")
    token = env["GH_TOKEN"]
    if env["GITHUB_EVENT_NAME"] == "pull_request_target":
        number = env["PR_NUMBER"]
        if not re.fullmatch(r"[1-9][0-9]*", number):
            raise ValueError("invalid PR number")
        pulls = [api(f"/pulls/{number}", token)]
    elif env["GITHUB_EVENT_NAME"] == "push" and env["GITHUB_REF"] == "refs/heads/master":
        pulls = []
        page = 1
        while True:
            batch = api(f"/pulls?state=open&base=master&per_page=100&page={page}", token)
            pulls.extend(batch)
            if len(batch) < 100:
                break
            page += 1
    else:
        raise ValueError("unsupported event")
    selected = [{"number": pr["number"]} for pr in pulls
                if pr.get("state") == "open" and pr.get("base", {}).get("ref") == "master"]
    if len(selected) > 256:
        raise ValueError("too many open PRs for one validation matrix")
    return selected


def current_candidate(env, api=github, sleep=time.sleep):
    number = env["PR_NUMBER"]
    if not re.fullmatch(r"[1-9][0-9]*", number) or env.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("unsupported PR or repository")
    for _ in range(10):
        pr = read_pr(number, env["GH_TOKEN"], api)
        if pr.get("number") != int(number) or pr.get("state") != "open":
            raise ValueError("PR is no longer open")
        sha = pr.get("merge_commit_sha")
        if pr.get("mergeable") is False:
            raise ValueError("PR has merge conflicts")
        if pr.get("mergeable") is True and isinstance(sha, str) and SHA.fullmatch(sha):
            master = api("/git/ref/heads/master", env["GH_TOKEN"])["object"]["sha"]
            commit = api(f"/git/commits/{sha}", env["GH_TOKEN"])
            parents = [parent["sha"] for parent in commit.get("parents", [])]
            if parents == [master, pr["head"]["sha"]]:
                merge_sha(pr)
                return {"sha": sha, "head-repo": pr["head"]["repo"]["full_name"],
                        "author": pr["user"]["login"],
                        "eligible": str(pr["head"]["repo"]["full_name"] == REPOSITORY
                                        and pr["user"]["login"] != "dependabot[bot]").lower()}
        sleep(2)
    raise ValueError("current PR merge candidate is not ready; rerun validation")


if __name__ == "__main__":
    try:
        mode = sys.argv[1]
        if mode == "list":
            values = {"candidates": json.dumps(candidates(os.environ), separators=(",", ":"))}
        elif mode == "select":
            values = current_candidate(os.environ)
        elif mode == "completed":
            # Recheck both parents after validation, including changes to master.
            current = current_candidate(os.environ)
            if current["sha"] != os.environ["EVENT_SHA"]:
                raise ValueError("candidate changed during validation")
            values = {"sha": completed_pr(os.environ)}
        elif mode == "pr":
            current = current_candidate(os.environ)
            if current["sha"] != os.environ["EVENT_SHA"]:
                raise ValueError("candidate changed before status publication")
            print(pr_gate(os.environ))
            values = {}
        else:
            raise ValueError("expected list, select, completed, or pr")
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key, value in values.items():
                output.write(f"{key}={value}\n")
    except (OSError, ValueError, KeyError, IndexError) as error:
        print(f"Node candidate gate failed: {error}", file=sys.stderr)
        sys.exit(1)
