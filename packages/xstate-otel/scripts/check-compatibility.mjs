// Runs typecheck, build and tests of @actorium/xstate-otel for every
// XState × @opentelemetry/api row. Each row installs into a disposable copy of
// the workspace, so it never touches this checkout or its lockfile.
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedVersion, pnpm } from '../../../scripts/workspace.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const packageName = '@actorium/xstate-otel';
const packagePath = 'packages/xstate-otel';
const packageInputs = [
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
  'src',
  'tests',
];
const checks = ['typecheck', 'build', 'test'];
const testSdk = '@opentelemetry/sdk-trace-base';

// Peer floors, development pins and the newest release. `latest` is a range,
// so it resolves to the newest version outside pnpm's minimumReleaseAge window.
const matrix = {
  xstate: { '5.33.0': '5.33.0', '5.33.2': '5.33.2', latest: '5' },
  '@opentelemetry/api': { '1.9.0': '1.9.0', latest: '1' },
};

function usage() {
  const labels = (name) => Object.keys(matrix[name]).join('|');
  return `Usage: pnpm run test:compatibility [--xstate ${labels('xstate')}] [--api ${labels('@opentelemetry/api')}] [--report path]`;
}

function parseOptions(args) {
  const options = { xstate: undefined, api: undefined, report: undefined };
  args = args.filter((arg) => arg !== '--');
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (value === undefined || value.startsWith('--')) throw new Error(usage());
    if (flag === '--report') options.report = resolve(process.env.INIT_CWD ?? '', value);
    else if (flag === '--xstate' && value in matrix.xstate) options.xstate = value;
    else if (flag === '--api' && value in matrix['@opentelemetry/api']) options.api = value;
    else throw new Error(usage());
  }
  return options;
}

function rows(options) {
  return Object.keys(matrix.xstate)
    .filter((xstate) => options.xstate === undefined || options.xstate === xstate)
    .flatMap((xstate) =>
      Object.keys(matrix['@opentelemetry/api'])
        .filter((api) => options.api === undefined || options.api === api)
        .map((api) => ({ xstate, api })),
    );
}

async function prepareWorkspace(row) {
  const workspace = await mkdtemp(join(tmpdir(), 'xstate-otel-compatibility-'));
  for (const input of ['package.json', 'pnpm-workspace.yaml']) {
    await cp(join(root, input), join(workspace, input));
  }
  for (const input of packageInputs) {
    await cp(join(root, packagePath, input), join(workspace, packagePath, input), {
      recursive: true,
    });
  }
  const manifestPath = join(workspace, packagePath, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.devDependencies.xstate = matrix.xstate[row.xstate];
  manifest.devDependencies['@opentelemetry/api'] = matrix['@opentelemetry/api'][row.api];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return workspace;
}

/** Installed versions, after checking that the test SDK shares the library's API instance. */
async function installed(packageRoot, row) {
  const versions = {
    xstate: await installedVersion(packageRoot, 'xstate'),
    '@opentelemetry/api': await installedVersion(packageRoot, '@opentelemetry/api'),
  };
  for (const [name, label] of [
    ['xstate', row.xstate],
    ['@opentelemetry/api', row.api],
  ]) {
    if (label !== 'latest' && versions[name] !== label) {
      throw new Error(`Expected ${name} ${label}, found ${versions[name]}`);
    }
  }
  // The test SDK is a dependency of the disposable workspace, not of this one.
  const require = createRequire(join(packageRoot, 'package.json'));
  const sdk = createRequire(await realpath(require.resolve(testSdk)));
  const [api, sdkApi] = await Promise.all(
    [require, sdk].map((from) => realpath(from.resolve('@opentelemetry/api'))),
  );
  if (api !== sdkApi) {
    throw new Error(`The test SDK resolved a second @opentelemetry/api: ${sdkApi}`);
  }
  return versions;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const report = { node: process.version, rows: [], passed: false };
  const seen = new Set();
  try {
    for (const row of rows(options)) {
      const workspace = await prepareWorkspace(row);
      try {
        console.log(`\nInstalling XState ${row.xstate} × @opentelemetry/api ${row.api}`);
        pnpm(workspace, ['install', '--lockfile=false', '--filter', packageName]);
        const packageRoot = join(workspace, packagePath);
        const versions = await installed(packageRoot, row);
        const key = `xstate@${versions.xstate} with @opentelemetry/api@${versions['@opentelemetry/api']}`;
        const result = { ...row, versions, checks: [], skipped: seen.has(key) };
        report.rows.push(result);
        if (result.skipped) {
          console.log(`Skipping ${key}: already checked`);
          continue;
        }
        seen.add(key);
        console.log(`Checking ${key} on Node ${process.version}`);
        for (const check of checks) {
          pnpm(packageRoot, ['run', check]);
          result.checks.push(check);
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
    report.passed = true;
    console.log(`\nCompatibility checks passed: ${[...seen].join(', ')}`);
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    if (options.report) await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
