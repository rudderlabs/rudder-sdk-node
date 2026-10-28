# Node PR candidate validation

The `Node PR candidate E2E` workflow validates the current merge commit for each
eligible PR. The workflow runs trusted code from `master`. It sends the PR number
and merge SHA to shared-action commit
`4932729bffd737fc92f9cbed32115b2621da2bcd` (reviewed and merged in shared-action #11).
The central runner executes candidate code in its isolated reliability job.
Candidate code does not receive workspace credentials or the caller's token.

A push to `master` selects all open PRs again. The selector waits for GitHub's
merge commit and checks both parents against current `master` and the PR head.
The workflow checks the same identity after validation and before posting the
`Node Candidate E2E` commit status. An obsolete run cannot approve a newer SHA.
Rerunning a workflow selects the current candidate, including after base updates.

Fork and Dependabot PRs do not mint the release App token. Their status explicitly
reports intentional exclusion from this central check. Existing native tests
still apply. Ordinary same-repository PRs and Release Please PRs use the same
isolated validation path; a bot name or branch name grants no additional trust.
The job display name is `Validate PR candidate`. Only the commit status uses
`Node Candidate E2E`.

## Release boundaries

This PR does not replace the publication or post-publication workflows. The
existing `deploy-npm.yml` dependency on the full release-event candidate check
remains intact. Published-package acceptance and validation-only retries are
maintained separately in [PR #502](https://github.com/rudderlabs/rudder-sdk-node/pull/502)
under [SDK-5963](https://linear.app/rudderstack/issue/SDK-5963).
The source candidate and publisher currently rebuild from the same release
commit. This PR does not claim that the central runner tested the exact uploaded
bytes. Artifact equality remains a separate release acceptance requirement.

## Required-check rollout

Tracked in [SDK-5980](https://linear.app/rudderstack/issue/SDK-5980).

The PR remains blocked by [the trigger security finding](https://github.com/rudderlabs/rudder-sdk-node/security/code-scanning/60).
The maintainer requested team review if the mobile implementation provided no
applicable exception. The [Kotlin caller](https://github.com/rudderlabs/rudder-sdk-kotlin/blob/main/.github/workflows/live-integration-tests.yml)
uses `pull_request` and skips forks. The [mobile test workflow](https://github.com/rudderlabs/rudder-mobile-sdk-test/blob/main/.github/workflows/live-pr-check-kotlin.yaml)
uses `workflow_dispatch`. Neither establishes a `pull_request_target` exception.
No scanner suppression or security-alert dismissal is included.

1. Merge the caller after review and passing native checks.
2. Verify the status on an ordinary PR and a Release Please PR.
3. Verify the documented fork and Dependabot exclusions.
4. Advance `master` and verify revalidation at the new merge SHA.
5. Confirm the status source and commit attachment in repository rules.
6. Propose `Node Candidate E2E` as a required status from that verified source.

Repository settings are unchanged. Do not claim enforcement until the final
rule is applied and verified. The workflow cannot run from this draft PR before
its trusted code exists on `master`.
