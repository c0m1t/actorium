import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const recording = fileURLToPath(new URL('../generated/showcase.json', import.meta.url));

function sourceUrl(): string | null {
  try {
    const directory = fileURLToPath(
      new URL('../', import.meta.resolve('@actorium/xstate-otel-showcase/viewer')),
    );
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const path = relative(git('rev-parse', '--show-toplevel'), directory)
      .split(sep)
      .map(encodeURIComponent)
      .join('/');
    const { repository } = createRequire(import.meta.url)('@actorium/xstate-otel/package.json') as {
      repository: { url: string };
    };
    return `${repository.url.replace(/^git\+/, '').replace(/\.git$/, '')}/tree/${git('rev-parse', 'HEAD')}/${path}`;
  } catch {
    return null;
  }
}

export default {
  watch: [recording],
  load: () => ({
    recordingUrl: existsSync(recording)
      ? JSON.parse(readFileSync(recording, 'utf8')).recordingUrl
      : null,
    sourceUrl: sourceUrl(),
  }),
};
