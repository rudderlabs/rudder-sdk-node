# Example dependency inventory

Each example is an independent npm project. Its committed `package-lock.json` records the published SDK and all resolved transitive dependencies for GitHub's dependency graph. The root lock does not cover these projects.

Run `npm ci --ignore-scripts` inside an example to reproduce its lock. To refresh its inventory, run `npm update --package-lock-only --ignore-scripts --before=<cutoff>` inside that directory, where `<cutoff>` is an ISO timestamp at least seven days before the refresh. Review the changes and commit its lock. Keep the existing manifest constraints and Node support policy.

Run `npm audit` after refreshing. The age cutoff can exclude a recent security fix. Record any remaining advisory and the excluded fix instead of treating a refreshed lock as vulnerability-free.

The sample-app `install:prod` command deliberately tests the latest published SDK. Its local-package command tests a built tarball. These commands can replace the locked SDK; their results do not describe the committed published-package inventory. Use a clean checkout for lock updates.

After merge, verify packages from all three example locks in GitHub's dependency graph. The existing monthly/zero-routine Dependabot policy is unchanged. Revert the lockfiles and ignore-rule change to roll back inventory tracking.
