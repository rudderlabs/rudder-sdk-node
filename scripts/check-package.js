const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..', 'dist');
const manifestPath = path.join(packageRoot, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

for (const field of ['main', 'module', 'types']) {
  assert.strictEqual(typeof manifest[field], 'string', `package.json is missing "${field}"`);
  assert.ok(!path.isAbsolute(manifest[field]), `${field} entry point must be relative`);
  assert.ok(
    !manifest[field].split(/[\\/]+/).includes('..'),
    `${field} entry point must not escape the package root`,
  );

  const entryPoint = path.resolve(packageRoot, manifest[field]);
  const relativeEntryPoint = path.relative(packageRoot, entryPoint);
  assert.ok(
    relativeEntryPoint &&
      !relativeEntryPoint.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeEntryPoint),
    `${field} entry point must remain within the package root`,
  );

  const entryPointStats = fs.statSync(entryPoint, { throwIfNoEntry: false });
  assert.ok(entryPointStats?.isFile(), `${field} entry point is not a file: ${manifest[field]}`);
}

const sdk = require(packageRoot);
assert.strictEqual(
  typeof sdk,
  'function',
  'CommonJS entry point does not export the SDK constructor',
);

console.log('Packaged SDK entry points are valid.');
