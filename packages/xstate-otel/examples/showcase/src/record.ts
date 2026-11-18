import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRecordedShowcasePage } from './recording.ts';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: pnpm run record <output.html>');

const page = await createRecordedShowcasePage();
const output = resolve(process.env.INIT_CWD ?? process.cwd(), destination);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, page);
console.log(`Recorded showcase: ${output}`);
