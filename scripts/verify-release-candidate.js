const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The shared action authenticates the central result. The publisher binds that
// result and the retained bytes to this release immediately before npm upload.
function verifyCandidate({
  report,
  packageFile,
  sha,
  validatedSha,
  tree,
  version,
  tag,
  head,
  refs,
}) {
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.match(version, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  assert.equal(tag, `v${version}`);
  assert.equal(head, sha);
  assert.equal(validatedSha, sha);
  assert.equal(report.schema_version, 1);
  assert.equal(report.sdk, 'node');
  assert.equal(report.selection, 'candidate');
  assert.equal(report.repository, 'rudderlabs/rudder-sdk-node');
  assert.equal(report.package, '@rudderstack/rudder-sdk-node');
  assert.equal(report.commit, sha);
  assert.equal(report.version, version);
  assert.equal(report.artifact.source_tree, tree);
  for (const key of ['delivery_passed', 'restoration_verified', 'lock_released']) {
    assert.equal(report[key], true);
  }
  const remote = new Map(
    refs
      .trim()
      .split('\n')
      .map((line) => {
        const [commit, ref] = line.trim().split(/\s+/);
        return [ref, commit];
      }),
  );
  assert.equal(remote.get('refs/heads/master'), sha, 'master advanced; publication must stop');
  assert.equal(
    remote.get(`refs/tags/${tag}^{}`) || remote.get(`refs/tags/${tag}`),
    sha,
    'release tag changed; publication must stop',
  );
  assert.ok(packageFile, 'the shared action must retain the tested package');
  assert.equal(path.basename(packageFile), report.artifact.package_file);
  const stat = fs.lstatSync(packageFile);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 32 * 1024 * 1024);
  const bytes = fs.readFileSync(packageFile);
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    report.artifact.package_sha256,
  );
  assert.equal(
    `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
    report.artifact.package_integrity,
  );
}

if (require.main === module) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const tag = process.env.RELEASE_TAG;
  assert.equal(tag, `v${version}`);
  assert.match(tag, /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  verifyCandidate({
    report: JSON.parse(process.env.CANDIDATE_REPORT),
    packageFile: process.env.PACKAGE_FILE,
    sha: process.env.GITHUB_SHA,
    validatedSha: process.env.VALIDATED_SHA,
    head: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    version,
    tag,
    refs: git(
      'ls-remote',
      '--exit-code',
      'origin',
      'refs/heads/master',
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ),
  });
}

module.exports = { verifyCandidate };
