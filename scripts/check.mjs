import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const files = (await readdir(new URL('../tests/', import.meta.url))).filter(n => n.endsWith('.test.mjs')).map(n => fileURLToPath(new URL(`../tests/${n}`, import.meta.url)));
if (!files.length) throw new Error('No tests discovered');
const stream = run({ files, concurrency: 3 });
stream.on('test:fail', () => { process.exitCode = 1; });
stream.compose(spec).pipe(process.stdout);
