import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

/** Only link files whose line numbers still match the pinned Git revision. */
export function createSourceLinker(
  directory: string,
  repositoryUrl: string,
): (file: string, line: number) => string | undefined {
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    // Git reports the real root, so resolve symlinks such as macOS's /var -> /private/var.
    const base = realpathSync(directory);
    const root = git('rev-parse', '--show-toplevel');
    const revision = git('rev-parse', 'HEAD');
    const clean = new Map<string, boolean>();
    return (file, line) => {
      const absolute = resolve(base, file);
      const path = relative(root, absolute).split(sep).join('/');
      if (!clean.has(path)) {
        try {
          git('cat-file', '-e', `${revision}:${path}`);
          clean.set(path, !git('status', '--porcelain', '--untracked-files=all', '--', absolute));
        } catch {
          clean.set(path, false);
        }
      }
      if (!clean.get(path)) return undefined;
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      return `${repositoryUrl}/blob/${revision}/${encoded}#L${line}`;
    };
  } catch {
    // Source archives have readable file labels without potentially stale links.
    return () => undefined;
  }
}
