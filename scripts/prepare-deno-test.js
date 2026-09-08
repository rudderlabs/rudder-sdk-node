const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const testRoot = path.join(repositoryRoot, '.deno-test');
const packageManifest = require(path.join(repositoryRoot, 'package.json'));

fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });

const packResult = JSON.parse(
  execFileSync(
    'npm',
    ['pack', './dist', '--ignore-scripts', '--json', '--pack-destination', testRoot],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  ),
);

if (packResult.length !== 1 || !packResult[0].filename) {
  throw new Error('npm pack did not produce exactly one package artifact.');
}

execFileSync('tar', ['-xzf', path.join(testRoot, packResult[0].filename), '-C', testRoot], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});

const artifactManifest = JSON.parse(
  fs.readFileSync(path.join(testRoot, 'package', 'package.json'), 'utf8'),
);
if (
  artifactManifest.name !== packageManifest.name ||
  artifactManifest.version !== packageManifest.version
) {
  throw new Error('The packed artifact does not match the repository package.');
}

fs.writeFileSync(
  path.join(testRoot, 'deno.json'),
  `${JSON.stringify(
    {
      imports: {
        [packageManifest.name]: `npm:${packageManifest.name}@${packageManifest.version}`,
      },
      links: ['./package'],
      lock: false,
      nodeModulesDir: 'auto',
    },
    null,
    2,
  )}\n`,
);

console.log(`Prepared Deno test package: ${packResult[0].filename}`);
