import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function buildStudioUi() {
  const { build } = await import(pathToFileURL(join(root, 'runtime/frontend/node_modules/esbuild/lib/main.js')));
  const output = join(root, 'build/ui');
  await rm(output, {recursive: true, force: true});
  await mkdir(output, {recursive: true});
  await cp(join(root, 'src/ui/public'), output, {recursive: true});
  await build({ entryPoints: [join(root, 'src/ui/editor.js')], outfile: join(root, 'build/ui/code-editor.js'), bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: true, sourcemap: false, legalComments: 'eof' });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildStudioUi();
