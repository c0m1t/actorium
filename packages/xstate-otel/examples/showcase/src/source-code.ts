import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createSourceLinker } from './source-links.ts';

interface SourceSnippet {
  file: string;
  line: number;
  code: string;
  html: string;
  href?: string;
}

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const tokenClasses = new Map([
  [ts.ClassificationType.keyword, 'keyword'],
  [ts.ClassificationType.stringLiteral, 'string'],
  [ts.ClassificationType.comment, 'comment'],
  [ts.ClassificationType.numericLiteral, 'number'],
  [ts.ClassificationType.bigintLiteral, 'number'],
]);

function highlight(code: string): string {
  const { spans } = ts
    .createClassifier()
    .getEncodedLexicalClassifications(code, ts.EndOfLineState.None, true);
  let html = '';
  let offset = 0;
  for (let i = 0; i < spans.length; i += 3) {
    const start = spans[i]!;
    const end = start + spans[i + 1]!;
    const tokenClass = tokenClasses.get(spans[i + 2]!);
    html += escapeHtml(code.slice(offset, start));
    const text = escapeHtml(code.slice(start, end));
    html += tokenClass ? `<span class="syntax-${tokenClass}">${text}</span>` : text;
    offset = end;
  }
  return html + escapeHtml(code.slice(offset));
}

function snippet(file: string, code: string, line = 1): SourceSnippet {
  // Preserve relative indentation while removing the enclosing array's indentation.
  const lines = code.split('\n');
  const indent = Math.min(
    ...lines
      .slice(1)
      .filter((text) => text.trim())
      .map((text) => text.length - text.trimStart().length),
  );
  const normalized = [lines[0], ...lines.slice(1).map((text) => text.slice(indent))].join('\n');
  return { file, line, code: normalized, html: highlight(normalized) };
}

/** Reads the real sources once when the live server or recording starts. */
export function createShowcasePage(): string {
  const text = readFileSync(new URL('./scenarios.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('scenarios.ts', text, ts.ScriptTarget.Latest, true);
  const scenarios: Record<string, SourceSnippet> = {};
  let context: SourceSnippet | undefined;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        declaration.name.getText(source) !== 'scenarios' ||
        !declaration.initializer ||
        !ts.isArrayLiteralExpression(declaration.initializer)
      )
        continue;
      context = snippet('src/scenarios.ts', text.slice(0, statement.getStart(source)).trimEnd());
      for (const entry of declaration.initializer.elements) {
        if (!ts.isObjectLiteralExpression(entry)) continue;
        const id = entry.properties.find(
          (property) => ts.isPropertyAssignment(property) && property.name.getText(source) === 'id',
        );
        if (!id || !ts.isPropertyAssignment(id) || !ts.isStringLiteral(id.initializer))
          throw new Error('Each showcase scenario needs a literal ID for its source snippet.');
        scenarios[id.initializer.text] = snippet(
          'src/scenarios.ts',
          entry.getText(source),
          source.getLineAndCharacterOfPosition(entry.getStart(source)).line + 1,
        );
      }
    }
  }
  if (!context || !Object.keys(scenarios).length)
    throw new Error('No showcase scenario sources found.');
  const fullFile = (name: string): SourceSnippet =>
    snippet(`src/${name}`, readFileSync(new URL(name, import.meta.url), 'utf8'));
  const sources = {
    context,
    scenarios,
    machine: [fullFile('desk.ts')],
    tracing: [fullFile('showcase.ts'), fullFile('telemetry.ts')],
  };
  const { repository } = createRequire(import.meta.url)('@actorium/xstate-otel/package.json') as {
    repository: { url: string };
  };
  const sourceLink = createSourceLinker(
    fileURLToPath(new URL('../', import.meta.url)),
    repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
  );
  for (const snippet of [
    context,
    ...Object.values(scenarios),
    ...sources.machine,
    ...sources.tracing,
  ]) {
    const href = sourceLink(snippet.file, snippet.line);
    if (href) snippet.href = href;
  }
  const data = JSON.stringify(sources).replaceAll('<', '\\u003c');
  return readFileSync(new URL('./page.html', import.meta.url), 'utf8')
    .replace(
      '<!-- showcase-styles -->',
      () => `<style>${readFileSync(new URL('./viewer.css', import.meta.url), 'utf8')}</style>`,
    )
    .replace('/* showcase-renderer */', () =>
      readFileSync(new URL('./viewer.js', import.meta.url), 'utf8'),
    )
    .replace(
      '<!-- showcase-sources -->',
      () => `<script type="application/json" id="showcase-sources">${data}</script>`,
    );
}
