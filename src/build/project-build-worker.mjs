// Only this trusted configuration executes; project vite/postcss/env configs are ignored.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readProjectSettings } from '../projects/project-settings.mjs';
const [project, runtime] = process.argv.slice(2);
const { build } = await import(pathToFileURL(join(runtime, 'node_modules/vite/dist/node/index.js')));
const { default: tailwindcss } = await import(pathToFileURL(join(runtime, 'node_modules/tailwindcss/lib/index.js')));
await build({ configFile: false, envFile: false, root: project, base: './', publicDir: false,
  define: Object.fromEntries(Object.entries(await readProjectSettings(project)).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])),
  plugins: [], esbuild: { jsx: 'automatic' },
  resolve: { alias: [ { find: /^@supabase\/supabase-js$/, replacement: join(runtime, 'node_modules/@supabase/supabase-js/dist/index.mjs') }, { find: /^react-dom(\/.*)?$/, replacement: join(runtime, 'node_modules/react-dom') + '$1' }, { find: /^react(\/.*)?$/, replacement: join(runtime, 'node_modules/react') + '$1' } ] },
  css: { postcss: { plugins: [tailwindcss({content:[join(project,'index.html'),join(project,'src/**/*.{js,jsx}')],theme:{extend:{}},plugins:[]})] } }, cacheDir: join(project, '.cache'),
  build: { outDir: join(project, 'dist'), emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
});
