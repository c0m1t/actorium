// Builds the attributes reference from the single name table in
// packages/xstate-otel/src/otel/attributes.ts, so the page cannot drift from
// what the library emits. The source is parsed, never executed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface AttributeRow {
  /** Property of `getAttributeKeys()`. */
  key: string;
  /** Name relative to the namespace. */
  name: string;
  /** Where the name appears, e.g. `Operation span`. */
  where: string;
  /** Meaning as HTML: escaped text with `code` spans. */
  meaning: string;
}

function inlineHtml(markdown: string): string {
  return markdown
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

const source = fileURLToPath(
  new URL('../../../packages/xstate-otel/src/otel/attributes.ts', import.meta.url),
);

export function attributeRows(file: string = source): AttributeRow[] {
  const text = readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let table: ts.ObjectLiteralExpression | undefined;
  tree.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      let value = declaration.initializer;
      if (value && ts.isAsExpression(value)) value = value.expression;
      if (declaration.name.getText() === 'names' && value && ts.isObjectLiteralExpression(value)) {
        table = value;
      }
    }
  });
  if (!table) throw new Error(`No \`names\` table in ${file}`);
  return table.properties.map((property) => {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) {
      throw new Error(`Unexpected entry in the names table: ${property.getText()}`);
    }
    const key = property.name.getText();
    const comment = ts
      .getLeadingCommentRanges(text, property.getFullStart())
      ?.map((range) => text.slice(range.pos, range.end))
      .join('\n');
    const match = /^\/\*\*\s*([^:]+):\s*([\s\S]+?)\s*\*\/$/.exec(comment?.trim() ?? '');
    if (!match) throw new Error(`Names table entry ${key} needs a "/** Where: meaning */" comment`);
    return {
      key,
      name: property.initializer.text,
      where: match[1]!,
      meaning: inlineHtml(match[2]!),
    };
  });
}

export default {
  watch: ['../../../packages/xstate-otel/src/otel/attributes.ts'],
  load: (): AttributeRow[] => attributeRows(),
};
