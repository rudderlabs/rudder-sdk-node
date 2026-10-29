/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
const { default: test } = require('ava');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { verifyCandidate } = require('../scripts/verify-release-candidate');

const workflow = (name) =>
  fs.readFileSync(path.join(__dirname, '../.github/workflows', `${name}.yml`), 'utf8');
const deploy = workflow('deploy-npm');
const published = workflow('published-sdk-e2e');

// Execute the actual workflow scripts. These steps contain no network requests.
const runBlock = (source, name) => {
  const step = source.split(`      - name: ${name}\n`)[1]?.split('\n      - name: ')[0];
  const script = step?.split('        run: |\n')[1];
  if (!script) throw new Error(`Missing workflow script: ${name}`);
  return script
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
};

const fixture = (t, overrides = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-release-workflow-'));
  t.teardown(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    PATH: process.env.PATH,
    GITHUB_OUTPUT: path.join(directory, 'output'),
    GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
    SLACK_CHANNEL_ID: 'test-channel',
    RELEASE_TAG: 'v3.0.17',
    RELEASE_URL: 'https://github.com/rudderlabs/rudder-sdk-node/releases/tag/v3.0.17',
    RUN_URL: 'https://github.com/rudderlabs/rudder-sdk-node/actions/runs/42',
    CENTRAL_RUN_URL: 'https://github.com/rudderlabs/rudder-sdk-e2e-tests/actions/runs/43',
    CANDIDATE_RESULT: 'success',
    PUBLISH_RESULT: 'success',
    UPLOADED: 'true',
    ACCEPTANCE_RESULT: 'success',
    ROOT_OK: 'true',
    ROOT_TS: '123.456',
    ...overrides,
  };
};

const execute = (source, name, env) => {
  fs.writeFileSync(env.GITHUB_OUTPUT, '');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', runBlock(source, name)], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const outputs = Object.fromEntries(
    fs
      .readFileSync(env.GITHUB_OUTPUT, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  return { ...result, outputs };
};

const outcomes = [
  ['accepted', {}, 'accepted'],
  ['failed E2E', { ACCEPTANCE_RESULT: 'failure' }, 'published; validation failed or incomplete'],
  ['skipped E2E', { ACCEPTANCE_RESULT: 'skipped' }, 'published; validation failed or incomplete'],
  [
    'cancelled E2E',
    { ACCEPTANCE_RESULT: 'cancelled' },
    'published; validation failed or incomplete',
  ],
  [
    'failure after upload',
    { PUBLISH_RESULT: 'failure', ACCEPTANCE_RESULT: 'skipped' },
    'published; validation failed or incomplete',
  ],
  [
    'failed upload',
    { PUBLISH_RESULT: 'failure', UPLOADED: '', ACCEPTANCE_RESULT: 'skipped' },
    'publication failed or unconfirmed; acceptance incomplete',
  ],
  [
    'cancelled publisher',
    { PUBLISH_RESULT: 'cancelled', UPLOADED: '', ACCEPTANCE_RESULT: 'skipped' },
    'publication failed or unconfirmed; acceptance incomplete',
  ],
  [
    'failed candidate',
    {
      CANDIDATE_RESULT: 'failure',
      PUBLISH_RESULT: 'skipped',
      UPLOADED: '',
      ACCEPTANCE_RESULT: 'skipped',
    },
    'publication not attempted; candidate validation failed or incomplete',
  ],
  [
    'unconfirmed upload',
    { UPLOADED: '' },
    'publication failed or unconfirmed; acceptance incomplete',
  ],
];

for (const [name, overrides, expected] of outcomes) {
  test(`release status: ${name}`, (t) => {
    const env = fixture(t, overrides);
    const root = execute(deploy, 'Prepare release status', env);
    t.is(root.status, 0, root.stderr);
    t.is(root.outputs.status, expected);
    const payload = JSON.parse(root.outputs.payload);
    t.true(payload.text.includes(`Node.js SDK v3.0.17 - ${expected}`));
    t.regex(payload.text, /\d{4}-\d{2}-\d{2}/);
    t.true(payload.text.includes('<!subteam^S0555JBV36D> <!subteam^S03SHJ20350>'));
    t.false(payload.text.includes('https://'));
    t.false(payload.unfurl_links);
    t.false(payload.unfurl_media);
    t.true(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').includes(expected));

    const thread = execute(deploy, 'Prepare thread details', {
      ...env,
      RELEASE_STATUS: root.outputs.status,
    });
    t.is(thread.status, 0, thread.stderr);
    const reply = JSON.parse(thread.outputs.payload);
    t.is(reply.channel, payload.channel);
    t.is(reply.thread_ts, env.ROOT_TS);
    t.false(reply.reply_broadcast);
    t.false(reply.unfurl_links);
    t.false(reply.unfurl_media);
    for (const link of [
      env.RELEASE_URL,
      env.RUN_URL,
      env.CENTRAL_RUN_URL,
      'https://www.npmjs.com/package/@rudderstack/rudder-sdk-node/v/3.0.17',
    ]) {
      t.true(reply.text.includes(link));
    }
    t.true(
      reply.text.includes(`full published E2E delivery and cleanup: ${env.ACCEPTANCE_RESULT}`),
    );
  });
}

test('payloads preserve quotes and newlines as JSON data', (t) => {
  const env = fixture(t, { SLACK_CHANNEL_ID: 'test-"channel"\nvalue', CENTRAL_RUN_URL: '' });
  const root = execute(deploy, 'Prepare release status', env);
  t.is(root.status, 0, root.stderr);
  t.is(JSON.parse(root.outputs.payload).channel, env.SLACK_CHANNEL_ID);
  const thread = execute(deploy, 'Prepare thread details', {
    ...env,
    RELEASE_STATUS: root.outputs.status,
  });
  t.is(thread.status, 0, thread.stderr);
  const reply = JSON.parse(thread.outputs.payload);
  t.is(reply.channel, env.SLACK_CHANNEL_ID);
  t.false(reply.text.includes('Central E2E run'));
});

for (const overrides of [{ ROOT_OK: 'false' }, { ROOT_TS: '' }, { ROOT_TS: 'invalid' }]) {
  test(`no channel-level reply after an unconfirmed Slack root: ${JSON.stringify(overrides)}`, (t) => {
    const env = fixture(t, overrides);
    const result = execute(deploy, 'Prepare thread details', env);
    t.is(result.status, 0, result.stderr);
    t.deepEqual(result.outputs, {});
    t.true(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').includes('no thread reply was sent'));
  });
}

test('publication and notification preserve the full acceptance dependency chain', (t) => {
  const publisher = deploy.split('\n  deploy-tag:\n')[1].split('\n  published-e2e:\n')[0];
  const acceptance = deploy.split('\n  published-e2e:\n')[1].split('\n  notify-slack:\n')[0];
  const notify = deploy.split('\n  notify-slack:\n')[1];
  t.true(publisher.includes('needs: validate-ref'));
  t.true(publisher.includes('suite: full'));
  t.true(publisher.includes('id: e2e'));
  t.true(
    publisher.includes(
      'node scripts/verify-release-candidate.js\n          npm publish "$PACKAGE_FILE" --provenance --ignore-scripts',
    ),
  );
  t.false(publisher.includes('cd dist'));
  t.false(publisher.includes('          ref:'));
  t.false(deploy.includes('workflow_dispatch:'));
  t.true(acceptance.includes('needs: deploy-tag'));
  t.true(acceptance.includes('package-version: ${{ needs.deploy-tag.outputs.version }}'));
  t.true(notify.includes("always() && needs.validate-ref.result == 'success'"));
  t.true(notify.includes('needs: [validate-ref, deploy-tag, published-e2e]'));
  t.true(notify.includes('needs.deploy-tag.outputs.candidate-result'));
  t.false(notify.includes('if: needs.published-e2e.result'));
  t.true(notify.includes("if: steps.thread.outputs.payload != ''"));
  t.false(notify.includes('payload-templated: true'));
  t.is(
    notify.match(/slackapi\/slack-github-action@dcb1066f776dd043e64d0e8ba94ca15cc7e1875d/g).length,
    2,
  );
});

test('validation-only retries delegate to a pinned shared workflow without publishing', (t) => {
  t.false(/npm publish|slack-github-action|id-token: write|actions\/checkout/.test(published));
  t.true(
    published.includes(
      'uses: rudderlabs/github-action-sdk-e2e/.github/workflows/published-sdk-e2e.yml@b6de40cc65abe8ee6c6593aac1787aea746b671f',
    ),
  );
  t.true(published.includes('package-version: ${{ inputs.package-version || github.ref_name }}'));
  t.true(published.includes('release-app-client-id: ${{ vars.RELEASE_APP_CLIENT_ID }}'));
  t.true(published.includes('value: ${{ jobs.validate.outputs.run-url }}'));
  t.false(published.includes('cancel-in-progress: true'));
});

test('publisher accepts only the exact tested bytes and current source release identity', (t) => {
  const env = fixture(t);
  const packageFile = path.join(path.dirname(env.GITHUB_OUTPUT), 'candidate.tgz');
  const bytes = Buffer.from('opaque native package bytes');
  fs.writeFileSync(packageFile, bytes);
  const sha = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const input = {
    sha,
    validatedSha: sha,
    head: sha,
    tree,
    version: '3.0.17',
    tag: 'v3.0.17',
    packageFile,
    refs: `${sha}\trefs/heads/master\n${sha}\trefs/tags/v3.0.17\n`,
    report: {
      schema_version: 1,
      sdk: 'node',
      selection: 'candidate',
      repository: 'rudderlabs/rudder-sdk-node',
      package: '@rudderstack/rudder-sdk-node',
      commit: sha,
      version: '3.0.17',
      delivery_passed: true,
      restoration_verified: true,
      lock_released: true,
      artifact: {
        source_tree: tree,
        package_file: 'candidate.tgz',
        package_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        package_integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      },
    },
  };
  t.notThrows(() => verifyCandidate(input));
  t.notThrows(() =>
    verifyCandidate({
      ...input,
      refs:
        input.refs.replace(`${sha}\trefs/tags/`, `${'c'.repeat(40)}\trefs/tags/`) +
        `${sha}\trefs/tags/v3.0.17^{}\n`,
    }),
  );
  for (const change of [
    { sha: 'c'.repeat(40) },
    { validatedSha: '' },
    { head: 'c'.repeat(40) },
    { tree: 'c'.repeat(40) },
    { version: '3.0.18' },
    { tag: 'v3.0.18' },
    { packageFile: '' },
    { refs: input.refs.replaceAll(sha, 'c'.repeat(40)) },
    { refs: `${sha}\trefs/heads/master` },
  ]) {
    t.throws(() => verifyCandidate({ ...input, ...change }));
  }
  for (const [key, value] of Object.entries({
    schema_version: 2,
    sdk: 'go',
    selection: 'published',
    repository: 'fork/node',
    package: 'another-package',
    commit: 'c'.repeat(40),
    version: '3.0.18',
    delivery_passed: false,
    restoration_verified: false,
    lock_released: false,
  })) {
    t.throws(() => verifyCandidate({ ...input, report: { ...input.report, [key]: value } }));
  }
  for (const key of ['package_sha256', 'package_integrity', 'package_file']) {
    t.throws(() =>
      verifyCandidate({
        ...input,
        report: { ...input.report, artifact: { ...input.report.artifact, [key]: 'invalid' } },
      }),
    );
  }
  fs.writeFileSync(packageFile, 'changed package');
  t.throws(() => verifyCandidate(input));
});

for (const [name, overrides, accepted] of [
  ['confirmed root and reply', { REPLY_OK: 'true' }, true],
  ['root API failure', { ROOT_OK: 'false', REPLY_OK: 'true' }, false],
  ['missing root timestamp', { ROOT_TS: '', REPLY_OK: 'true' }, false],
  ['thread API failure', { REPLY_OK: 'false' }, false],
  ['skipped thread', { REPLY_OK: '' }, false],
]) {
  test(`notification outcome: ${name}`, (t) => {
    const env = fixture(t, overrides);
    const result = execute(deploy, 'Require confirmed release notification', env);
    t.is(result.status === 0, accepted, result.stderr);
    if (!accepted) {
      t.true(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8').includes('notification failed'));
    }
  });
}
