import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';

let temporary: string;
let runtimeUrl: string;
beforeAll(async () => {
  // Compile the current runtime, so subprocess coverage never tests stale dist.
  temporary = await mkdtemp(join(tmpdir(), 'otel-root-errors-'));
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
  for (const file of await readdir(sourceRoot, { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    let { outputText } = ts.transpileModule(await readFile(join(sourceRoot, file), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    });
    for (const dependency of ['xstate', '@opentelemetry/api']) {
      outputText = outputText.replaceAll(
        `'${dependency}'`,
        JSON.stringify(import.meta.resolve(dependency)),
      );
    }
    const output = join(temporary, file.replace(/\.ts$/, '.js'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, outputText);
  }
  await writeFile(join(temporary, 'package.json'), '{ "type": "module" }');
  runtimeUrl = pathToFileURL(join(temporary, 'index.js')).href;
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function run(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/root-error-process.mjs', import.meta.url)), ...args],
    {
      env: { ...process.env, TRACING_RUNTIME: runtimeUrl },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

const native = new Map<string, ReturnType<typeof run>>();
function assertParity(
  scenario: string,
  reporter = 'default',
  outcome = 'outside',
  value = 'error',
  observer = 'none',
  target = 'root',
) {
  const key = JSON.stringify([scenario, value, observer, target]);
  let control = native.get(key);
  if (!control) {
    control = run('native', scenario, 'default', 'outside', value, observer, target);
    native.set(key, control);
  }
  const result = run('traced', scenario, reporter, outcome, value, observer, target);
  const handled = scenario.startsWith('handled-');
  const expected =
    target === 'root'
      ? handled || observer === 'error'
        ? 0
        : 1
      : !handled || observer === 'next' || observer === 'both'
        ? 1
        : 0;
  expect(control.status, control.stderr).toBe(expected);
  expect(result.status, result.stderr).toBe(control.status);
  for (const process of [control, result]) {
    expect(process.stdout, process.stderr).toContain('CHECKED');
    expect(process.stderr).not.toContain('AssertionError');
    expect(process.stdout.includes('SURVIVED')).toBe(expected === 0);
    if (expected === 1)
      expect(process.stderr).toContain(
        scenario === 'guard' ? 'Unable to evaluate guard' : 'ORIGINAL_ROOT_FAILURE',
      );
    else expect(process.stderr).toBe('');
  }
  expect(result.stderr).not.toContain('XState root actor failed');
  expect(result.stderr).not.toContain('REPORTER_FAILURE');
  for (const marker of ['ORIGINAL_ROOT_FAILURE', 'Unable to evaluate guard']) {
    expect(result.stderr.split(marker).length).toBe(control.stderr.split(marker).length);
  }
  expect(result.stdout.match(/REPORT /g) ?? []).toHaveLength(
    reporter !== 'default' && !handled ? 1 : 0,
  );
  const phase = outcome === 'outside' ? 'unassociatedRootError' : 'associatedRootError';
  if (reporter !== 'default' && !handled)
    expect(result.stdout).toContain(`REPORT ${phase} ORIGINAL`);
  if (!['promise', 'handled-promise'].includes(scenario) && observer === 'error')
    expect(result.stdout.match(/APPLICATION_ORIGINAL/g) ?? []).toHaveLength(
      !handled || target === 'child' ? 1 : 0,
    );
}

it.each([
  'context',
  'startup',
  'action',
  'guard',
  'child',
  'handled-child',
  'promise',
  'handled-promise',
  'nested-startup',
  'callback-root',
  'observable-root',
  'restored-error',
])(
  'preserves native default reporting for %s with and without an application handler',
  (scenario) => {
    for (const observer of ['none', 'error'])
      assertParity(scenario, 'default', 'outside', 'error', observer);
  },
);

for (const scenario of ['action', 'promise', 'handled-promise']) {
  for (const outcome of ['outside', 'failed']) {
    for (const reporter of ['default', 'custom', 'throwing']) {
      it.each(['error', 'string'])(
        `${scenario}/${outcome}/${reporter}: original %s and native reporting`,
        (value) => {
          for (const observer of ['none', 'error'])
            assertParity(scenario, reporter, outcome, value, observer);
        },
      );
    }
  }
}

for (const scenario of ['child', 'handled-child', 'promise', 'handled-promise']) {
  for (const target of ['root', 'child']) {
    it.each(['none', 'error', 'next', 'both'])(
      `${scenario}/${target}: preserves native subscriber policy for %s`,
      (observer) => {
        assertParity(scenario, 'throwing', 'outside', 'error', observer, target);
      },
    );
  }
}
