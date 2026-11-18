import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Runs pnpm in `cwd`, failing on a non-zero exit. Returns stdout when `capture` is set. */
export function pnpm(cwd, args, { capture = false } = {}) {
  // `pnpm run` may supply a Node script or the native pnpm executable.
  const cli = process.env.npm_execpath ?? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  const nodeScript = /\.[cm]?js$/.test(cli);
  const result = spawnSync(
    nodeScript ? process.execPath : cli,
    nodeScript ? [cli, ...args] : args,
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
      shell: process.platform === 'win32' && cli.endsWith('.cmd'),
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} failed (${result.signal ?? result.status})`);
  }
  return result.stdout;
}

/** Version of a direct dependency installed for the package at `packageRoot`. */
export async function installedVersion(packageRoot, name) {
  const manifest = join(packageRoot, 'node_modules', name, 'package.json');
  return JSON.parse(await readFile(manifest, 'utf8')).version;
}
