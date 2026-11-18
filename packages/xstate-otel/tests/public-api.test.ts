import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Every change to the published declarations shows up as a snapshot diff, so
// API changes are reviewed deliberately (run `vitest -u` to accept one). The
// build uses isolatedDeclarations, so per-file declaration emit is exact.

const sourceRoot = new URL('../src/', import.meta.url);

async function declarations(file: string): Promise<string> {
  const source = await readFile(new URL(file, sourceRoot), 'utf8');
  const result = ts.transpileDeclaration(source, {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext },
    reportDiagnostics: true,
  });
  expect(result.diagnostics ?? []).toEqual([]);
  return result.outputText;
}

/** Source files whose declarations are public: index.ts and what it re-exports. */
async function publicFiles(): Promise<string[]> {
  const files = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (files.has(file)) return;
    files.add(file);
    const source = await readFile(new URL(file, sourceRoot), 'utf8');
    for (const [, specifier] of source.matchAll(/^export\b[^;]*?\bfrom\s+'(\.[^']+)'/gms)) {
      await visit(posix.join(posix.dirname(file), specifier!.replace(/\.js$/, '.ts')));
    }
  };
  await visit('index.ts');
  return [...files].sort();
}

it('keeps the published declarations unchanged', async () => {
  const files = await publicFiles();
  const api = await Promise.all(
    files.map(async (file) => `// ${file}\n${await declarations(file)}`),
  );
  expect(api.join('\n')).toMatchSnapshot();
});
