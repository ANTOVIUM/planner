import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const assets = ['index.html', 'styles.css', 'script.js', 'core.js', 'quotes.js', 'offline.js', 'cloud.js', 'supabase-config.js', 'supabase-api.js', 'task-sync.js', 'manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch.png', 'fonts/inter-cyrillic.woff2', 'fonts/inter-cyrillic-ext.woff2', 'fonts/inter-latin.woff2', 'fonts/inter-latin-ext.woff2'];
const entries = [];
for (const path of assets) {
  const content = await readFile(new URL(path, root));
  const integrity = `sha256-${createHash('sha256').update(content).digest('base64')}`;
  if (path === 'index.html') entries.push(['./', integrity]);
  entries.push([`./${path}`, integrity]);
}
const url = new URL('sw.js', root);
const source = await readFile(url, 'utf8');
const block = /\/\/ BEGIN GENERATED PRECACHE[\s\S]*?\/\/ END GENERATED PRECACHE/;
if (!block.test(source)) throw new Error('Missing precache markers');
const version = createHash('sha256').update(JSON.stringify(entries)).update(source.replace(block, '')).digest('hex').slice(0, 16);
await writeFile(url, source.replace(block, `// BEGIN GENERATED PRECACHE\nconst VERSION = '${version}';\nconst PRECACHE = ${JSON.stringify(entries, null, 2)};\n// END GENERATED PRECACHE`));
console.log(`Offline shell ${version}: ${entries.length} verified files.`);
