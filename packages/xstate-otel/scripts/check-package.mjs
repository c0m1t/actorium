// Packs @actorium/xstate-otel the way it is published, then checks what a
// consumer receives: the file list, publint, Are the Types Wrong and a smoke
// test that typechecks and runs against the installed tarball.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedVersion, pnpm } from '../../../scripts/workspace.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const packageRoot = join(root, 'packages/xstate-otel');
const require = createRequire(join(packageRoot, 'package.json'));

function node(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`node ${args.join(' ')} failed (${result.status})`);
}

/** Only compiled output for current sources, the sources for source maps, and metadata. */
async function expectedFiles() {
  const modules = (await readdir(join(packageRoot, 'src'), { recursive: true }))
    .filter((path) => path.endsWith('.ts'))
    .map((path) => path.replaceAll('\\', '/').slice(0, -'.ts'.length));
  return [
    'LICENSE',
    'README.md',
    'package.json',
    ...modules.flatMap((module) => [
      `src/${module}.ts`,
      ...['.js', '.js.map', '.d.ts', '.d.ts.map'].map((extension) => `dist/${module}${extension}`),
    ]),
  ].sort();
}

const work = await mkdtemp(join(tmpdir(), 'xstate-otel-package-'));
try {
  // `pack` runs `prepack`, which rebuilds dist from scratch.
  const output = pnpm(packageRoot, ['pack', '--json', '--pack-destination', work], {
    capture: true,
  });
  // stdout starts with the prepack script's echo, then the JSON report.
  const packed = JSON.parse(output.slice(output.indexOf('{')));
  const files = packed.files.map((file) => file.path).sort();
  assert.deepEqual(files, await expectedFiles(), 'Unexpected file list in the packed tarball');
  console.log(`Packed ${packed.files.length} files into ${packed.filename}`);

  pnpm(root, ['exec', 'publint', 'run', '--strict', packed.filename]);
  pnpm(root, ['exec', 'attw', '--profile', 'esm-only', packed.filename]);

  const consumer = join(work, 'consumer');
  const dependencies = { '@actorium/xstate-otel': `file:${packed.filename}` };
  for (const name of [
    '@opentelemetry/api',
    '@opentelemetry/sdk-trace-base',
    '@types/node',
    'xstate',
  ]) {
    dependencies[name] = await installedVersion(packageRoot, name);
  }
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'xstate-otel-consumer', private: true, type: 'module', dependencies }, null, 2)}\n`,
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          lib: ['ES2023'],
          module: 'NodeNext',
          strict: true,
          types: ['node'],
          noEmit: true,
        },
        include: ['smoke.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await copyFile(join(packageRoot, 'scripts/package-smoke.ts'), join(consumer, 'smoke.ts'));
  pnpm(consumer, ['install', '--ignore-workspace', '--prefer-offline']);
  node(consumer, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json']);
  node(consumer, ['smoke.ts']);
} finally {
  await rm(work, { recursive: true, force: true });
}
