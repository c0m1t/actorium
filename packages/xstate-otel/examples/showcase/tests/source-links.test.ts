import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createSourceLinker } from '../src/source-links.ts';

const repository = 'https://github.com/c0m1t/actorium';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(prefix = '') {
  const directory = mkdtempSync(join(tmpdir(), 'showcase-source-links-'));
  directories.push(directory);
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const file = `${prefix}packages/showcase/src/scenario file.ts`;
  mkdirSync(dirname(join(directory, file)), { recursive: true });
  writeFileSync(join(directory, file), '// first line\nexport const scenario = {};\n');
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=Showcase tests',
    '-c',
    'user.email=tests@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  return { directory, file, git, revision: git('rev-parse', 'HEAD') };
}

test.each(['', 'standalone/'])(
  'pins clean source paths and line numbers with prefix %j',
  (prefix) => {
    const { directory, file, revision } = fixture(prefix);
    expect(createSourceLinker(directory, repository)(file, 2)).toBe(
      `${repository}/blob/${revision}/${file.replace(' ', '%20')}#L2`,
    );
  },
);

test.each([false, true])('omits links to edited source files (staged: %j)', (staged) => {
  const { directory, file, git } = fixture();
  writeFileSync(
    join(directory, file),
    '// local edit\n// first line\nexport const scenario = {};\n',
  );
  if (staged) git('add', file);
  expect(createSourceLinker(directory, repository)(file, 2)).toBeUndefined();
});

test('unrelated edits do not suppress links, and untracked files get no link', () => {
  const { directory, file, revision } = fixture();
  writeFileSync(join(directory, 'untracked.ts'), '// not in the commit\n');
  const link = createSourceLinker(directory, repository);
  expect(link(file, 2)).toContain(`/blob/${revision}/`);
  expect(link('untracked.ts', 1)).toBeUndefined();
});

test('a source archive without Git metadata keeps plain file labels', () => {
  const directory = mkdtempSync(join(tmpdir(), 'showcase-source-archive-'));
  directories.push(directory);
  writeFileSync(join(directory, 'scenario.ts'), 'export const scenario = {};\n');
  expect(createSourceLinker(directory, repository)('scenario.ts', 1)).toBeUndefined();
});
