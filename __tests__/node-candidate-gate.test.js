/* eslint-disable unicorn/filename-case -- `__tests__` is the test directory */
const { default: test } = require('ava');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
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

test('base updates list every open PR with pagination; PR events select one', (t) => {
  const code = `import node_candidate_gate as g
p={'number':42,'state':'open','base':{'ref':'master'}}
env={'GITHUB_REPOSITORY':g.REPOSITORY,'GH_TOKEN':'test','GITHUB_EVENT_NAME':'push','GITHUB_REF':'refs/heads/master'}
pages=[]
def api(path,token):
 pages.append(path)
 return [p]*100 if path.endswith('&page=1') else [dict(p,number=43)]
print(len(g.candidates(env,api)))
print(len(pages))
env.update(GITHUB_EVENT_NAME='pull_request_target',PR_NUMBER='42')
print(g.candidates(env,lambda *a:p))
print(g.candidates(env,lambda *a:dict(p,state='closed')))
`;
  t.is(runPython(code), "101\n2\n[{'number': 42}]\n[]");
});

test('selection waits for a merge commit with current base and head parents', (t) => {
  const code = `import node_candidate_gate as g
base='b'*40; head='c'*40; merge='a'*40
p={'number':42,'state':'open','mergeable':True,'merge_commit_sha':merge,'base':{'ref':'master'},'head':{'sha':head,'repo':{'full_name':g.REPOSITORY}},'user':{'login':'release-bot'}}
env={'PR_NUMBER':'42','GITHUB_REPOSITORY':g.REPOSITORY,'GH_TOKEN':'test'}
calls=[]
def api(path,token):
 if path.startswith('/pulls/'): return p
 if path=='/git/ref/heads/master': return {'object':{'sha':base}}
 calls.append(path)
 return {'parents':[{'sha':base if len(calls)>1 else 'd'*40},{'sha':head}]}
print(g.current_candidate(env,api,sleep=lambda _:None)['sha'])
print(len(calls))
p['head']['repo']['full_name']='fork/node'
print(g.current_candidate(env,api,sleep=lambda _:None)['eligible'])
p['head']['repo']['full_name']=g.REPOSITORY
p['user']['login']='dependabot[bot]'
print(g.current_candidate(env,api,sleep=lambda _:None)['eligible'])
p['mergeable']=False
try: g.current_candidate(env,api,sleep=lambda _:None)
except ValueError: print('conflict rejected')
`;
  t.is(runPython(code), `${sha}\n2\nfalse\nfalse\nconflict rejected`);
});

test('selection rejects a changed PR head and an unready candidate', (t) => {
  const code = `import node_candidate_gate as g
p={'number':42,'state':'open','mergeable':True,'merge_commit_sha':'a'*40,'base':{'ref':'master'},'head':{'sha':'c'*40,'repo':{'full_name':g.REPOSITORY}},'user':{'login':'release-bot'}}
env={'PR_NUMBER':'42','GITHUB_REPOSITORY':g.REPOSITORY,'GH_TOKEN':'test'}
def api(path,token):
 if path.startswith('/pulls/'): return p
 if path=='/git/ref/heads/master': return {'object':{'sha':'b'*40}}
 return {'parents':[{'sha':'b'*40},{'sha':'d'*40}]}
for ready in [True,None]:
 p['mergeable']=ready
 try: g.current_candidate(env,api,sleep=lambda _:None)
 except ValueError: print('rejected')
`;
  t.is(runPython(code), 'rejected\nrejected');
});

test('PR status publication is separate from reusable release validation', (t) => {
  const read = (name) => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
  const candidate = read('node-candidate-e2e.yml');
  const release = read('server-sdk-e2e.yml');
  t.true(candidate.includes('pull_request_target:'));
  t.true(candidate.includes('push:'));
  t.true(candidate.includes('branches: [master]'));
  t.true(candidate.includes('name: Validate PR candidate'));
  t.false(candidate.includes('name: Node Candidate E2E'));
  t.true(candidate.includes('pr-number: ${{ matrix.candidate.number }}'));
  t.true(candidate.includes('merge-sha: ${{ steps.candidate.outputs.sha }}'));
  t.true(
    candidate.includes('rudderlabs/github-action-sdk-e2e@4932729bffd737fc92f9cbed32115b2621da2bcd'),
  );
  t.true(candidate.includes("if: steps.candidate.outputs.eligible == 'true'"));
  t.true(candidate.includes("if: always() && steps.candidate.outputs.sha != ''"));
  t.false(/npm publish|npm ci|ref:.*head|ref:.*merge|suite: full/.test(candidate));
  t.false(release.includes('statuses: write'));
  t.false(release.includes('pull_request:'));
});
