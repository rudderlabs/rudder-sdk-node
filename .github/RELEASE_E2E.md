# Published Node SDK acceptance

The published-package workflow runs the full central E2E suite for the exact stable release version. It uses the existing release App and waits for delivery validation and cleanup. The central workflow checks the release tag against the immutable event commit and `master` ancestry. It installs the exact public registry package and verifies native package metadata and integrity evidence.

Acceptance starts only after the existing publisher succeeds. Existing native build, security, and publication checks remain in place. The final Slack notification waits for both publication and published-package acceptance to finish.

Node retains the full source-candidate E2E gate before npm publication.

Existing manual publication must select a release tag. A master-branch dispatch cannot bind the uploaded artifact to a release tag and is no longer a publication path.

## Release notification

The short channel post contains the SDK, version, UTC date, final status, and existing release mentions. A non-broadcast thread reply contains the exact npm version, release, workflow, and available central-run links, plus the check results. Link previews are disabled. The existing Slack action pin, channel, and bot credential are preserved.

- `accepted` requires a confirmed upload and successful full published-package E2E, including registry verification, delivery, and cleanup.
- A confirmed upload followed by failed, skipped, or cancelled acceptance reports `published; validation failed or incomplete`.
- An unsuccessful or unconfirmed upload reports `publication failed or unconfirmed; acceptance incomplete`. This does not assert that the package is absent from npm.
- If candidate validation prevents publication, the notification reports that publication was not attempted.

The workflow records the result in its GitHub summary before contacting Slack. Slack errors cannot erase that summary or turn failed acceptance into success. A thread reply requires a confirmed root message and a valid timestamp.

## Validation-only retry

1. Open the failed central run from the shared action summary.
2. Resolve the validation failure.
3. Run this workflow at the existing release tag:

```sh
gh workflow run published-sdk-e2e.yml --repo rudderlabs/rudder-sdk-node --ref vX.Y.Z
```

The retry has no upload path or publishing credential. It derives the exact version and commit from the selected tag. It does not use `latest`, publish a package, or recreate a tag. Tags predating this workflow need an exact-version dispatch through the central workflow. Stable `X.Y.Z` versions are supported; prerelease acceptance is not implemented.

A published package remains published if acceptance fails. Do not rerun a successful upload job to retry E2E. A successful validation-only retry does not change an earlier failed run or its notification. Record the new acceptance run in the release ticket and existing Slack release thread.

## Rollout

Tracked in [SDK-5963](https://linear.app/rudderstack/issue/SDK-5963). Merge only after [central PR #32](https://github.com/rudderlabs/rudder-sdk-e2e-tests/pull/32), [shared-action PR #5](https://github.com/rudderlabs/github-action-sdk-e2e/pull/5), and the shared reusable workflow in [SDK-5977](https://linear.app/rudderstack/issue/SDK-5977) are reviewed and available. The current local validation wrapper must migrate to the reviewed shared workflow at a full commit SHA before merge. The existing action pin is a commit from PR #5 and must be verified or refreshed during that migration.

Both validation dispatch jobs use `ubuntu-latest`. Hosted acceptance remains pending the next normal release. Do not create a release solely to test this wiring. The separate Release Please PR candidate gate remains tracked in [SDK-5980](https://linear.app/rudderstack/issue/SDK-5980).
