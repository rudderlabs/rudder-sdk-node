/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
const { default: test } = require('ava');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts/node_candidate_gate.py');
const sha = 'a'.repeat(40);
const next = 'b'.repeat(40);
const rootRepo = 'rudderlabs/rudder-sdk-node';

function runPython(source) {
  return execFileSync(
    'python3',
    [
      '-c',
      `import sys\nsys.path.insert(0, ${JSON.stringify(path.join(root, 'scripts'))})\n${source}`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  ).trim();
}

function pr(merge = sha, head = 'rudderlabs/rudder-sdk-node') {
  return {
    number: 42,
    state: 'open',
    merge_commit_sha: merge,
    base: { ref: 'master' },
    head: { repo: { full_name: head } },
  };
}

test('only current same-repository merge candidates can be selected', (t) => {
  const cases = [
    [pr(), sha],
    [pr(next), 'error'],
    [pr(sha, 'fork/node'), 'error'],
    [{ ...pr(), base: { ref: 'other' } }, 'error'],
    [{ ...pr(), merge_commit_sha: null }, 'error'],
  ];
  for (const [candidate, expected] of cases) {
    const code =
      `import json, node_candidate_gate as g\np=json.loads(${JSON.stringify(JSON.stringify(candidate))})\n` +
      `env={'PR_NUMBER':'42','EVENT_SHA':'${sha}','GITHUB_REPOSITORY':g.REPOSITORY,'GH_TOKEN':'test'}\n` +
      `try:\n print(g.select_pr(env, api=lambda *a:p))\nexcept ValueError:\n print('error')`;
    t.is(runPython(code), expected);
  }
});

test('eligible PR aggregate rejects missing, skipped, failed, cancelled and stale validation', (t) => {
  for (const result of ['missing', 'skipped', 'failure', 'cancelled', 'success']) {
    const validated = result === 'success' ? next : sha;
    const code =
      `import json, node_candidate_gate as g\np=json.loads(${JSON.stringify(JSON.stringify(pr()))})\n` +
      `try:\n print(g.pr_decision(p,'${sha}',g.REPOSITORY,'release-bot','${result}','${validated}')[0])\nexcept ValueError:\n print('failure')`;
    t.is(runPython(code), 'failure');
  }
  const code =
    `import json, node_candidate_gate as g\np=json.loads(${JSON.stringify(JSON.stringify(pr()))})\n` +
    `print(g.pr_decision(p,'${sha}',g.REPOSITORY,'release-bot','success','${sha}')[0])`;
  t.is(runPython(code), 'success');
  t.is(
    runPython(
      code
        .replace(
          `p=json.loads(${JSON.stringify(JSON.stringify(pr()))})`,
          `p=json.loads(${JSON.stringify(JSON.stringify(pr(next)))})`,
        )
        .replaceAll(sha, next),
    ),
    'success',
  );
});

test('aggregate never approves or overwrites the newer SHA from an obsolete event', (t) => {
  for (const [head, author, result, validated, expected] of [
    [rootRepo, 'release-bot', 'success', sha, `${sha} Node Candidate E2E success`],
    [rootRepo, 'release-bot', 'skipped', '', `${sha} Node Candidate E2E failure`],
    [rootRepo, 'release-bot', 'cancelled', '', `${sha} Node Candidate E2E failure`],
    [rootRepo, 'release-bot', 'success', next, 'no status'],
    ['fork/node', 'contributor', 'skipped', '', 'no status'],
    [rootRepo, 'dependabot[bot]', 'skipped', '', 'no status'],
  ]) {
    const candidate = pr(expected === 'no status' ? next : sha, head);
    const code =
      `import json, node_candidate_gate as g\np=json.loads(${JSON.stringify(JSON.stringify(candidate))})\n` +
      `env={'PR_NUMBER':'42','EVENT_SHA':'${sha}','GITHUB_REPOSITORY':g.REPOSITORY,'GH_TOKEN':'test','HEAD_REPO':'${head}','PR_AUTHOR':'${author}','VALIDATION_RESULT':'${result}','VALIDATED_SHA':'${validated}','VALIDATION_RUN':'','GITHUB_SERVER_URL':'https://github.com'}\n` +
      `try:\n g.pr_gate(env, api=lambda *a:p, post=lambda target,payload:print(target,payload['context'],payload['state']))\nexcept ValueError:\n pass\n` +
      `print('no status') if p['merge_commit_sha'] != env['EVENT_SHA'] else None`;
    t.is(runPython(code), expected);
  }
});

test('a completed PR run must still match the current merge candidate', (t) => {
  for (const [candidate, validated, run, expected] of [
    [pr(), sha, '123', 'success'],
    [pr(next), sha, '123', 'rejected'],
    [pr(), next, '123', 'rejected'],
    [pr(), sha, '', 'rejected'],
  ]) {
    const code =
      `import json, node_candidate_gate as g\np=json.loads(${JSON.stringify(JSON.stringify(candidate))})\n` +
      `env={'PR_NUMBER':'42','EVENT_SHA':'${sha}','GITHUB_REPOSITORY':g.REPOSITORY,'GH_TOKEN':'test','VALIDATED_SHA':'${validated}','VALIDATION_RUN':'${run}'}\n` +
      `try:\n g.completed_pr(env,api=lambda *a:p)\n print('success')\nexcept ValueError:\n print('rejected')`;
    t.is(runPython(code), expected);
  }
});

test('fork and Dependabot have the same context but no privileged validation', (t) => {
  for (const [head, author] of [
    ['fork/node', 'contributor'],
    ['rudderlabs/rudder-sdk-node', 'dependabot[bot]'],
  ]) {
    const code =
      `import json, node_candidate_gate as g\np=json.loads(${JSON.stringify(JSON.stringify(pr(sha, head)))})\n` +
      `print(g.pr_decision(p,'${sha}','${head}','${author}','skipped','')[0])\n` +
      `try:\n g.pr_decision(p,'${sha}','${head}','${author}','success','${sha}')\nexcept ValueError:\n print('rejected')`;
    t.is(runPython(code), 'success\nrejected');
  }
});

test('release identity rejects advanced master, mismatched versions and unsupported refs', (t) => {
  const code =
    `import node_candidate_gate as g\n` +
    `print(g.release_identity('v3.0.17','v3.0.17','${sha}','${sha}','3.0.17'))`;
  t.is(runPython(code), 'None');
  for (const [tag, release, commit, master, version] of [
    ['v3.0.17', 'v3.0.17', sha, next, '3.0.17'],
    ['v3.0.17', 'v3.0.18', sha, sha, '3.0.17'],
    ['v3.0.17', 'v3.0.17', sha, sha, '3.0.18'],
    ['master', 'master', sha, sha, '3.0.17'],
    ['v3.0.17-rc.1', 'v3.0.17-rc.1', sha, sha, '3.0.17-rc.1'],
  ]) {
    const expression = `g.release_identity(${[tag, release, commit, master, version].map(JSON.stringify).join(',')})`;
    t.is(
      runPython(
        `import node_candidate_gate as g\ntry:\n ${expression}\nexcept ValueError:\n print('rejected')`,
      ),
      'rejected',
    );
  }
});

test('workflow graph gates publication and retry has no upload or tag creation', (t) => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-npm.yml'), 'utf8');
  const retry = fs.readFileSync(path.join(root, '.github/workflows/published-sdk-e2e.yml'), 'utf8');
  const prWorkflow = fs.readFileSync(
    path.join(root, '.github/workflows/server-sdk-e2e.yml'),
    'utf8',
  );
  t.regex(workflow, /sdk-e2e:[\s\S]+needs: validate-ref[\s\S]+suite: full/);
  t.regex(workflow, /deploy-tag:[\s\S]+needs: \[validate-ref, sdk-e2e\]/);
  t.regex(
    workflow,
    /python3 gate\/scripts\/node_candidate_gate\.py artifact "\$TARBALL" "\$VALIDATED_VERSION" "\$DIGEST"\s+npm publish --ignore-scripts "\$TARBALL"/,
  );
  t.regex(workflow, /published-e2e:[\s\S]+needs: deploy-tag/);
  t.regex(workflow, /ref: master\s+path: gate/);
  t.regex(workflow, /npm pack --json --ignore-scripts/);
  t.regex(prWorkflow, /pr-number: \$\{\{ github.event.pull_request.number \}\}/);
  t.regex(prWorkflow, /merge-sha: \$\{\{ steps.candidate.outputs.sha \}\}/);
  t.notRegex(prWorkflow, /\sGITHUB_SHA:\s*\$\{\{/);
  t.notRegex(workflow, /workflow_dispatch:/);
  t.notRegex(retry, /npm publish|git tag|id-token: write/);
  t.regex(prWorkflow, /pr-gate:[\s\S]+name: Node Candidate E2E[\s\S]+if: always\(\)/);
});

test('npm pack filename comes from exactly one safe JSON entry', (t) => {
  const code =
    `import json, tempfile, pathlib, node_candidate_gate as g\n` +
    `with tempfile.TemporaryDirectory() as tmp:\n` +
    ` p=pathlib.Path(tmp)\n (p/'new-package-name.tgz').touch()\n` +
    ` print(g.pack_file(p,json.dumps([{'filename':'new-package-name.tgz'}])).name)\n` +
    ` for value in [[],[{'filename':'../outside.tgz'}],[{'filename':'new-package-name.tgz'},{'filename':'other.tgz'}]]:\n` +
    `  try: g.pack_file(p,json.dumps(value))\n  except ValueError: print('rejected')`;
  t.is(runPython(code), 'new-package-name.tgz\nrejected\nrejected\nrejected');
});

test('packed artifact digest detects substitutions and wrong package versions', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-release-'));
  try {
    const packageDir = path.join(temp, 'package');
    fs.mkdirSync(packageDir);
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@rudderstack/rudder-sdk-node', version: '3.0.17' }),
    );
    const archive = path.join(temp, 'package.tgz');
    execFileSync('tar', ['-czf', archive, '-C', temp, 'package']);
    const digest = execFileSync('python3', [script, 'artifact', archive, '3.0.17'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    t.regex(digest, /^[a-f0-9]{64}$/);
    t.is(spawnSync('python3', [script, 'artifact', archive, '3.0.18'], { cwd: root }).status, 1);
    fs.writeFileSync(path.join(packageDir, 'extra.txt'), 'changed');
    execFileSync('tar', ['-czf', archive, '-C', temp, 'package']);
    t.is(
      spawnSync('python3', [script, 'artifact', archive, '3.0.17', digest], { cwd: root }).status,
      1,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
