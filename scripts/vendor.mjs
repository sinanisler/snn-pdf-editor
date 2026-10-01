// Copies the browser builds of the PDF libraries into src/vendor so the app works offline.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'vendor');
mkdirSync(out, { recursive: true });
const files = {
  'pdf.min.js': 'pdfjs-dist/build/pdf.min.js',
  'pdf.worker.min.js': 'pdfjs-dist/build/pdf.worker.min.js',
  'pdf-lib.min.js': 'pdf-lib/dist/pdf-lib.min.js',
  'fontkit.umd.min.js': '@pdf-lib/fontkit/dist/fontkit.umd.min.js',
};
for (const [name, from] of Object.entries(files)) {
  copyFileSync(join(root, 'node_modules', from), join(out, name));
  console.log('vendored', name);
}
