const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..', 'dist');
const manifestPath = path.join(packageRoot, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

for (const field of ['main', 'module', 'types']) {
  assert.strictEqual(typeof manifest[field], 'string', `package.json is missing "${field}"`);

  const entryPoint = path.resolve(packageRoot, manifest[field]);
  assert.ok(fs.existsSync(entryPoint), `${field} entry point does not exist: ${manifest[field]}`);
}

const sdk = require(packageRoot);
assert.strictEqual(
  typeof sdk,
  'function',
  'CommonJS entry point does not export the SDK constructor',
);

console.log('Packaged SDK entry points are valid.');
