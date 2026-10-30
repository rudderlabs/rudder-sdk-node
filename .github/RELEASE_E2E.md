# Node live E2E

The `Server SDK E2E / Node SDK candidate gate` check runs on same-repository
Release Please PRs targeting `master`. Ordinary PRs retain the separate build,
unit, type, and Deno checks. They do not dispatch central reliability tests.

The caller does not check out or execute PR code. It creates an App token scoped
to central Actions and invokes the shared action at
`2d1262f86e519195dc723a8d244a8ecc8bcedb21`. Fork and Dependabot events are excluded before token creation.
The `release-please--` prefix selects when the check runs; it does not grant
trust to candidate code. Central prepares the exact merge candidate in an
isolated container and checks current PR identity before and after testing.

The full suite tests Node through the real dev data plane, temporary Terraform
source/destination/connection, Cloudflare tunnel, and Webhook receiver. A passing
result requires payload validation and verified deletion of that run's resources.
Each run owns separate resources, so concurrent runs do not edit each other.

## Release and publication

Keep Release Please unchanged. Require the live check before merging its release
PR. After merge, `deploy-npm.yml` builds the release-event commit and publishes
`dist` with npm provenance. It does not repeat candidate E2E after merge.

The PR check validates the source candidate. It does not claim that a later npm
build is byte-identical. The separate published-package check installs the exact
registry version and verifies its integrity, live delivery, and cleanup.

Publication and registry acceptance determine the release notification. A failed
acceptance cannot undo an upload. Details stay in the release thread. A failed
notification remains visible in the workflow summary.

## Rollout

Merge with central #46/#47 and the other callers under
[SDK-6016](https://linear.app/rudderstack/issue/SDK-6016).
[SDK-5980](https://linear.app/rudderstack/issue/SDK-5980) tracks the Node caller.
The shared action is merged, but the central schema-2 lifecycle must be active
before this caller runs. No compatibility fallback is provided.

Require `Node SDK candidate gate` from GitHub Actions and strict up-to-date
branches before release activation. Existing native checks remain required.
Repository settings are not changed by this PR. A base update must update the
release PR so GitHub creates a fresh merge candidate and runs its checks again.
Rerunning an old event does not validate a new candidate.

Hosted release-PR and published-package acceptance remains under
[SDK-5797](https://linear.app/rudderstack/issue/SDK-5797).
Do not create a release solely to test this wiring.

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
