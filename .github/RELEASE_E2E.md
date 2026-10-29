# Node PR candidate validation

The `Node PR candidate E2E` workflow uses `pull_request` for PR updates and
`push` for updates to `master`. Same-repository writers are trusted to run
workflow changes with repository secrets. This matches the existing repository
trust model. External contributors can trigger fork PR workflows, subject to
GitHub's approval policy, but do not receive repository secrets or write tokens.
Organization membership alone does not determine this access.

The privileged jobs exclude forks and Dependabot before checkout. The guard
checks both the PR author and the original workflow actor, so a maintainer rerun
does not enable a Dependabot PR. Eligible PR jobs load gate code from the event's
merge commit. Master push jobs load gate code from the pushed commit.
An actor check alone never grants an exclusion. If Dependabot triggers an
otherwise eligible PR, that run cannot validate or report an exclusion.

The caller sends the PR number and current merge SHA to shared-action commit
`b6de40cc65abe8ee6c6593aac1787aea746b671f` (shared-action v1.0.0).
The central runner executes candidate code in its isolated reliability job.
Candidate code does not receive workspace credentials or the caller's token.

A push to `master` selects all open PRs again. The selector waits for GitHub's
merge commit and checks both parents against current `master` and the PR head.
The workflow checks the same identity after validation and before publishing
its result. An obsolete run cannot approve a newer SHA. A PR event must still
match its original merge SHA. A rerun of a stale PR event fails before token
creation. After a base update, the master-push workflow validates the new candidate.

## Check reporting and exclusions

`Node Candidate E2E` is a GitHub check, not a commit status:

- Eligible PRs publish a completed check at the exact current merge SHA through
  the Checks API. Failed or missing validation produces a failure, or leaves the
  required check absent if candidate selection itself fails.
- Fork and Dependabot PR events use a separate no-permission job. This job has no
  checkout, secret access, token creation, or API write. GitHub reports its
  successful check on the PR head. Its summary states that central validation is
  intentionally excluded. Existing native tests still apply.
- On master pushes, the publisher can report a `skipped` check for excluded PRs
  at their current merge SHA. It never creates the release App token for them.

The exclusion job uses `Node Candidate E2E` only for excluded PR events. For
eligible PRs, its informational job has the different name `Report excluded PRs`.
This prevents an informational head check from satisfying the candidate requirement
when central validation fails. The matrix job remains `Validate PR candidate`.
No commit status shares the required check name.

This workflow uses the same `pull_request` model as the
[Kotlin caller](https://github.com/rudderlabs/rudder-sdk-kotlin/blob/main/.github/workflows/live-integration-tests.yml).
No scanner suppression or security-alert dismissal is included.

## Release boundaries

PR validation cannot authorize publication. The full source-candidate check runs
inside `deploy-npm.yml` before npm upload. The publisher uploads the exact tested
archive, as described below. Independent published-package acceptance and
validation-only retries remain tracked in
[SDK-5963](https://linear.app/rudderstack/issue/SDK-5963).

## Required-check rollout

Tracked in [SDK-5980](https://linear.app/rudderstack/issue/SDK-5980).

1. Verify the check on an ordinary PR and a Release Please PR.
2. Verify the documented fork and Dependabot exclusions, including reruns.
3. Merge the caller after review and passing checks.
4. Advance `master` and verify revalidation at the new merge SHA.
5. Confirm check attachment and the GitHub Actions source in repository rules.
6. Propose `Node Candidate E2E` as a required check from that verified source.

Repository settings are unchanged. Do not claim enforcement until the final
rule is applied and verified. PR validation can run before this workflow reaches
`master`; automatic base-update validation starts after merge.

The rules read on 29 October 2026 require the native unit, build, and PR-title
checks. They do not require `Node Candidate E2E`. The pilot check remains
advisory until the rollout above is complete.

## Exact package publication and registry acceptance

Publication starts only from a stable GitHub release event. A validation retry
uses the separate workflow below. There is one automatic publication trigger.

The publisher preserves native installation and build checks. It then runs the
full shared source-candidate check at the release-event commit. The shared action
returns authenticated result JSON and the exact tested npm archive. Immediately
before upload, the publisher checks the result's source selection, repository,
commit, package, version, source tree, delivery, restoration, and lock release.
It also checks both archive digests and requires the release tag and current
`master` to resolve to the release-event commit. If `master` advances, publication
stops. The publisher uploads the retained archive with npm provenance. It does
not upload the local rebuild.

After upload, `published-sdk-e2e.yml` uses the shared v1.0.0 workflow at
`b6de40cc65abe8ee6c6593aac1787aea746b671f`. That workflow checks the exact public
npm version, registry integrity, delivery, and cleanup. Source acceptance and
registry acceptance remain separate checks.

The final notification waits for publication and registry acceptance. The short
channel post contains the SDK, version, UTC date, final status, and release
mentions. The thread reply contains the exact npm version, release, workflow,
and available central-run links. Replies do not broadcast. Link previews are off.
A confirmed upload followed by failed acceptance reports the package as published
with incomplete acceptance. A failed notification cannot erase the workflow summary.

### Validation-only retry

1. Open the failed central run.
2. Resolve the validation failure.
3. Run the retry at the existing release tag:

```sh
gh workflow run published-sdk-e2e.yml --repo rudderlabs/rudder-sdk-node --ref vX.Y.Z
```

The retry workflow must exist on the default branch and selected tag. Older tags
need an exact-version dispatch through the central workflow. The retry cannot
publish, create tags, or send release notifications. A published package remains
published when acceptance fails. Record successful retry evidence in the release
ticket and existing release thread.

A tag retry uses workflow code and pins stored at that tag. If a workflow fix
was merged later, use the current central workflow instead. Copy the full commit
SHA from the original release run. Replace the example version, commit
placeholder, and request ID before running:

```sh
gh workflow run server-sdk-validation.yml --repo rudderlabs/rudder-sdk-e2e-tests --ref main \
  -f selection=auto -f source_repository=rudderlabs/rudder-sdk-node \
  -f source_sha=RELEASE_EVENT_COMMIT_SHA -f package_version=X.Y.Z \
  -f suite=full -f request_id=node-published-X_Y_Z-retry-UNIQUE_ID
```

Release-run reruns send no announcement after the first attempt. If notification
fails, repair the existing release thread separately.

Tracked in [SDK-5963](https://linear.app/rudderstack/issue/SDK-5963) and
[SDK-5980](https://linear.app/rudderstack/issue/SDK-5980). Required-check rollout
remains separate. Hosted pre-publication and registry acceptance will run during
the next normal release. Do not create a release solely to test this wiring.
