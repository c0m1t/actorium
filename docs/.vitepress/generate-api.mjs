import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Application } from 'typedoc';
import { createSourceLinker } from '@actorium/xstate-otel-showcase/source-links';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const { repository } = createRequire(import.meta.url)('@actorium/xstate-otel/package.json');
const link = createSourceLinker(cwd, repository.url.replace(/^git\+/, '').replace(/\.git$/, ''));
const app = await Application.bootstrapWithPlugins({
  options: fileURLToPath(new URL('../typedoc.json', import.meta.url)),
  // Supply source URLs ourselves: TypeDoc does not discover .git worktree files.
  disableGit: true,
  sourceLinkTemplate: '{path}#L{line}',
});
function check() {
  if (
    app.logger.hasErrors() ||
    (app.options.getValue('treatWarningsAsErrors') && app.logger.hasWarnings())
  ) {
    throw new Error('TypeDoc generation failed; see diagnostics above.');
  }
}
check();
const project = await app.convert();
if (!project) throw new Error('TypeDoc could not convert the library.');
for (const reflection of Object.values(project.reflections)) {
  for (const source of reflection.sources ?? []) {
    source.url = link(source.fullFileName, source.line);
  }
}
app.validate(project);
check();
await app.generateOutputs(project);
check();
