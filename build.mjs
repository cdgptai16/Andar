// Inlines engine.js and app.js into one self-contained HTML file: dist/index.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

const engine = read('src/engine.js');
const app = read('src/app.js');
for (const [name, src] of [['engine.js', engine], ['app.js', app]]) {
  if (/<\/script/i.test(src)) throw new Error(`${name} contains "</script", which would break inlining.`);
}

const html = read('src/app.html')
  .replace('/*@@ENGINE@@*/', () => engine)
  .replace('/*@@APP@@*/', () => app);
if (html.includes('@@ENGINE@@') || html.includes('@@APP@@')) throw new Error('Placeholder not replaced.');

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/index.html'), html);
console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB`);
