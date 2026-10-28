/* eslint-disable unicorn/filename-case -- AVA tests use .test.js */
const { default: test } = require('ava');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const root = path.resolve(__dirname, '..');
const workflow = (name) =>
  YAML.parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const deploy = workflow('deploy-npm.yml');
const retry = workflow('validate-published-npm.yml');
const e2e = workflow('server-sdk-e2e.yml');
const has = (needs, job) => [needs].flat().includes(job);
const steps = (job) => job.steps || [];

const releaseSha = spawnSync('git', ['rev-parse', 'refs/tags/v3.0.17^{commit}'], {
  cwd: root,
  encoding: 'utf8',
}).stdout.trim();

test('a single automatic release trigger retains full candidate validation before npm publication', (t) => {
  t.deepEqual(deploy.on, { release: { types: ['published'] } });
  t.is(deploy.jobs['sdk-e2e'].with.suite, 'full');
  t.true(has(deploy.jobs['deploy-tag'].needs, 'sdk-e2e'));
  t.falsy(deploy.jobs['deploy-tag'].if);
  t.regex(deploy.jobs['sdk-e2e'].if, /prerelease/);
  t.regex(deploy.jobs['sdk-e2e'].if, /github\.ref/);
  t.true(
    steps(deploy.jobs['deploy-tag']).findIndex((step) => step.id === 'release') <
      steps(deploy.jobs['deploy-tag']).findIndex((step) => step.run?.includes('npm publish')),
  );
  t.truthy(
    steps(deploy.jobs['deploy-tag']).find((step) => step.env?.RELEASE_SHA === '${{ github.sha }}'),
  );
  t.is(deploy.jobs['deploy-tag'].outputs.version, '${{ steps.release.outputs.version }}');
  t.truthy(
    steps(deploy.jobs['deploy-tag']).find((step) => step.run?.includes('dist/package.json')),
  );
  t.truthy(steps(deploy.jobs['deploy-tag']).find((step) => step.run?.includes('npm run package')));
  t.truthy(deploy.jobs['deploy-tag'].permissions['id-token']);
});

test('registry propagation and exact published package full E2E gate release-complete Slack', (t) => {
  t.true(has(deploy.jobs['registry-acceptance'].needs, 'deploy-tag'));
  t.true(has(deploy.jobs['published-e2e'].needs, 'registry-acceptance'));
  t.true(has(deploy.jobs['published-e2e'].needs, 'deploy-tag'));
  t.is(deploy.jobs['published-e2e'].with.suite, 'full');
  t.is(
    deploy.jobs['published-e2e'].with['package-version'],
    '${{ needs.deploy-tag.outputs.version }}',
  );
  t.is(
    deploy.jobs['published-e2e'].with['source-sha'],
    '${{ needs.deploy-tag.outputs.source-sha }}',
  );
  t.falsy(deploy.jobs['release-complete'].if);
  for (const gate of ['registry-acceptance', 'published-e2e']) {
    t.true(has(deploy.jobs['release-complete'].needs, gate));
    t.true(has(deploy.jobs['acceptance-failed'].needs, gate));
    t.regex(deploy.jobs['acceptance-failed'].if, new RegExp(`${gate}\\.result != 'success'`));
  }
  t.truthy(
    steps(deploy.jobs['registry-acceptance']).find((step) =>
      step.run?.includes('for attempt in {1..20}'),
    ),
  );
  t.truthy(steps(deploy.jobs['registry-acceptance']).find((step) => step.run?.includes('exit 1')));
  t.false(steps(deploy.jobs['release-complete']).some((step) => step['continue-on-error']));
  t.regex(deploy.jobs['acceptance-failed'].if, /always\(\)/);
  t.regex(deploy.jobs['acceptance-failed'].if, /needs\.deploy-tag\.result == 'success'/);
  t.truthy(steps(deploy.jobs['acceptance-failed']).find((step) => step.run?.includes('exit 1')));
});

test('retry cannot publish and validates a historical release before full E2E', (t) => {
  t.deepEqual(Object.keys(retry.on), ['workflow_dispatch']);
  t.true(retry.on.workflow_dispatch.inputs.version.required);
  t.true(retry.on.workflow_dispatch.inputs['source-sha'].required);
  t.true(has(retry.jobs['published-e2e'].needs, 'verify-release'));
  t.is(retry.jobs['published-e2e'].with.suite, 'full');
  t.is(
    retry.jobs['published-e2e'].with['package-version'],
    '${{ needs.verify-release.outputs.version }}',
  );
  t.is(
    retry.jobs['published-e2e'].with['source-sha'],
    '${{ needs.verify-release.outputs.source-sha }}',
  );
  t.false(JSON.stringify(retry).includes('npm publish'));
  t.false(JSON.stringify(retry).includes('deploy-tag'));
  const verification = steps(retry.jobs['verify-release']);
  t.truthy(verification.find((step) => step.name === 'Checkout trusted verification code'));
  t.truthy(
    verification.find(
      (step) =>
        step.name === 'Checkout immutable release commit separately' &&
        step.with.path === 'release-source' &&
        step.with.ref === '${{ inputs.source-sha }}',
    ),
  );
  t.truthy(verification.find((step) => step.run?.includes('python3 ../scripts/verify-release.py')));
  t.truthy(verification.find((step) => step.env?.CHECK_RELEASE_API === 'true'));
  t.true(has(retry.jobs['retry-accepted'].needs, 'published-e2e'));
  t.true(has(retry.jobs['retry-accepted'].needs, 'verify-release'));
  t.falsy(retry.jobs['retry-accepted'].if);
  const notification = steps(retry.jobs['retry-accepted']).find(
    (step) => step.with?.method === 'chat.postMessage',
  );
  t.regex(notification.with.payload, /validation-only retry accepted/);
  t.regex(notification.with.payload, /did not publish a new version/);
  t.is(notification.env.RELEASE_VERSION, '${{ needs.verify-release.outputs.version }}');
  t.false(notification['continue-on-error'] || false);
});

test('shared caller isolates PR reliability, App secrets, and fails closed until reviewed pin', (t) => {
  t.is(e2e.jobs.validate.with, undefined);
  t.regex(e2e.jobs.validate.if, /head\.repo\.full_name == github\.repository/);
  t.regex(e2e.jobs.validate.if, /dependabot\[bot\]/);
  const token = steps(e2e.jobs.validate).find((step) => step.id === 'token');
  t.is(token.with.repositories, 'rudder-sdk-e2e-tests');
  t.is(token.with['permission-actions'], 'write');
  const dispatch = steps(e2e.jobs.validate).find((step) =>
    step.uses?.startsWith('rudderlabs/github-action-sdk-e2e@'),
  );
  t.regex(dispatch.with.suite, /pull_request' && 'reliability'/);
  t.regex(dispatch.with.suite, /inputs\.suite \|\| vars\.SDK_E2E_SUITE/);
  t.is(e2e.on.workflow_call.inputs.suite.default, undefined);
  t.is(dispatch.env.GITHUB_SHA, '${{ inputs.source-sha || github.sha }}');
  t.is(dispatch.if, "inputs.package-version == ''");
  t.truthy(
    steps(e2e.jobs.validate).find(
      (step) => step.if === "inputs.package-version != ''" && step.run.includes('exit 1'),
    ),
  );
  t.false(dispatch['continue-on-error'] || false);
});

test('release identity accepts a historical checkout and rejects mismatched or unsafe values', (t) => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'node-release-'));
  try {
    const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
    t.is(git('clone', '--quiet', '--shared', '--no-checkout', root, checkout).status, 0);
    t.is(git('-C', checkout, 'checkout', '--quiet', '--detach', releaseSha).status, 0);
    const master = git('-C', root, 'rev-parse', 'refs/remotes/origin/master').stdout.trim();
    t.is(git('-C', checkout, 'update-ref', 'refs/remotes/origin/master', master).status, 0);
    // v3.0.17 predates the verifier; run the current verifier against its manifests.
    t.false(fs.existsSync(path.join(checkout, 'scripts/verify-release.py')));
    const run = (version, sha, extra = {}) =>
      spawnSync('python3', [path.join(root, 'scripts/verify-release.py')], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          ...process.env,
          RELEASE_VERSION: version,
          RELEASE_SHA: sha,
          RELEASE_EVENT_PATH: path.join(root, '__tests__', 'release-event.json'),
          ...extra,
        },
      });
    t.is(run('3.0.17', releaseSha).status, 0);
    for (const [version, sha] of [
      ['latest', releaseSha],
      ['3.0.18', releaseSha],
      ['3.0.17;id', releaseSha],
      ['3.0.17\n', releaseSha],
      ['3.0.17', 'a'.repeat(40)],
      ['3.0.17', 'master'],
    ]) {
      t.not(run(version, sha).status, 0);
    }
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
