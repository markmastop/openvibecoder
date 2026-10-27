import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const template = fileURLToPath(new URL('../../templates/', import.meta.url));

export function projectPath(path) {
  if (typeof path === 'string' && path.startsWith('src/studio/')) throw new Error("Open Vibe Coder manages the base components and connection clients.");
  if (['src/main.jsx', 'src/tailwind.css'].includes(path)) throw new Error("Open Vibe Coder manages this entry file.");
  if (typeof path !== 'string' || path.length > 180 || !/^(src\/[a-zA-Z0-9_/-]+\.(jsx|js|css|json)|README\.md)$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error("Only source files under src/ and README.md are editable.");
  return path;
}
export function parseProject(content, {requireApp = true} = {}) {
  if (typeof content !== 'string' || content.length > 300_000) throw new Error("The project response is missing or too large.");
  const text = content.replace(/^\s*```json\s*\n/, '').replace(/\n```\s*$/, '');
  let data;
  try { data = JSON.parse(text); }
  catch {
    // Accept only one complete, explicitly named App.jsx block. Never guess paths,
    // extract arbitrary braces, evaluate prose, or relax the later source checks.
    const blocks = [...content.matchAll(/^```([^\r\n`]*)\r?\n([\s\S]*?)^```[ \t]*$/gm)];
    const block = blocks[0];
    const prefix = block ? content.slice(0, block.index) : '';
    const suffix = block ? content.slice(block.index + block[0].length) : '';
    const named = /`(?:src\/)?App\.jsx`[ \t]*:?[ \t]*\r?\n[ \t\r\n]*$/.test(prefix);
    if (blocks.length !== 1 || !/^(jsx|javascript|js)$/i.test(block?.[1].trim() || '') || !named || prefix.includes('```') || suffix.includes('```')) {
      throw new Error("The model response contains neither valid JSON nor one clearly named App.jsx code block. Your existing app was preserved.");
    }
    data = { files: [{ path: 'src/App.jsx', content: block[2] }] };
  }
  // Normalize only an unambiguous single-file envelope; keep every existing check.
  const files = data && !Array.isArray(data) && !Object.hasOwn(data, 'files') && Object.keys(data).length === 2 && Object.hasOwn(data, 'path') && Object.hasOwn(data, 'content') ? [data] : data?.files;
  if (!Array.isArray(files) || !files.length || files.length > 30) throw new Error("The model returned files in an unexpected format. Your existing app was preserved.");
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error("Invalid source file in model response.");
    projectPath(file.path);
    if (seen.has(file.path) || typeof file.content !== 'string' || file.content.length > 80_000) throw new Error("Duplicate file or invalid content.");
    seen.add(file.path);
  }
  if (requireApp && !seen.has('src/App.jsx')) throw new Error("src/App.jsx is missing.");
  return files;
}
// Validate all edits in memory before the runner writes any file. No fuzzy matching.
export function parseEdits(content, sources) {
  if (typeof content !== 'string' || content.length > 80000) throw new Error("The patch is missing or too large.");
  const data = JSON.parse(content.replace(/^\s*```json\s*\n/, '').replace(/\n```\s*$/, ''));
  if (!data || !Array.isArray(data.edits) || !data.edits.length || data.edits.length > 12 || data.files) throw new Error("Expected at most 12 targeted changes. Choose a large change if complete files are needed.");
  const original = new Map(sources.map(f=>[f.path,f.content]));
  const changed = new Map();
  for (const edit of data.edits) {
    if (!edit || typeof edit !== 'object') throw new Error("Invalid patch.");
    projectPath(edit.path);
    const source = changed.get(edit.path) ?? original.get(edit.path);
    if (typeof source !== 'string' || typeof edit.search !== 'string' || !edit.search.length || typeof edit.replace !== 'string' || edit.search.length > 16000 || edit.replace.length > 20000) throw new Error("The patch does not contain a valid targeted change.");
    const first = source.indexOf(edit.search);
    if (first < 0 || source.indexOf(edit.search,first+1) >= 0) throw new Error("The patch does not match the current code unambiguously. Nothing was saved. Name the file or choose a large change.");
    // Ignore verified no-ops, but still reject missing/ambiguous targets above.
    if (edit.search === edit.replace) continue;
    const result = source.slice(0,first)+edit.replace+source.slice(first+edit.search.length);
    if (result.length>80000) throw new Error("The changed file is too large.");
    changed.set(edit.path,result);
  }
  for (const [path, content] of changed) if (content === original.get(path)) changed.delete(path);
  if (!changed.size) throw new Error("The model made no changes: all replacements are unchanged. Nothing was saved.");
  return [...changed].map(([path,content])=>({path,content}));
}
export function validateScreenStructure(files, plan) {
  if (!plan.separateScreens) return;
  const app=files.find(f=>f.path==='src/App.jsx');
  if (!files.some(f=>/^src\/screens\/[a-zA-Z0-9_/-]+\.jsx$/.test(f.path))) throw new Error("This screen request must produce a separate file under src/screens/. Nothing was saved.");
  if (!app || app.content.length>12000 || app.content.split('\n').length>220) throw new Error("App.jsx is too large: keep navigation in App.jsx and put screens under src/screens/. Nothing was saved.");
  if (!/(?:from\s*|import\s*\()['"]\.\/screens\//.test(app.content)) throw new Error("App.jsx must use the separate screens under src/screens/. Nothing was saved.");
}
export async function saveSource(directory, path, content) {
  projectPath(path);
  if (typeof content !== 'string' || content.length > 80_000) throw new Error("The file is too large.");
  let current = directory;
  if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not allowed.");
  const parts = path.split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    await mkdir(current, { recursive: true });
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not allowed.");
  }
  const target = join(directory, path);
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error("Symbolic links are not allowed."); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (path === 'src/App.jsx') {
    let previous = ''; try { previous = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous.includes('// BIM-APP-SHELL v1') && previous !== content) throw new Error("Open Vibe Coder manages the portal entry App.jsx. Edit screens or app-config.json.");
  }
  await writeFile(target, content);
}
export async function scaffold(directory, runtime, {template: templateKind = 'portal', name = "My app"} = {}) {
  const runtimePackage = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
  const deps = runtimePackage.dependencies;
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'bim-student-app', private: true, version: '0.1.0', type: 'module', scripts: { dev: 'vite --host 127.0.0.1', build: 'vite build' }, dependencies: deps, overrides: runtimePackage.overrides }, null, 2));
  await writeFile(join(directory, 'index.html'), "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"><title>My app</title></head><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.jsx\"></script></body></html>");
  await writeFile(join(directory, 'vite.config.js'), "import { defineConfig } from 'vite';\nimport tailwindcss from 'tailwindcss';\nexport default defineConfig({base:'./',css:{postcss:{plugins:[tailwindcss({content:['./index.html','./src/**/*.{js,jsx}'],theme:{extend:{}},plugins:[]})]}},esbuild:{jsx:'automatic'}});\n");
  await writeFile(join(directory, 'src/main.jsx'), "import React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport App from './App.jsx';\nimport './tailwind.css';\nimport './styles.css';\ncreateRoot(document.getElementById('root')).render(<App/>);\n");
  await writeFile(join(directory, 'src/tailwind.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  await writeFile(join(directory, 'src/styles.css'), "/* Additional custom styles. Tailwind is already loaded. */\n");
  await ensureProjectConnections(directory, runtime);
  if(templateKind==='portal') {
    const {cp}=await import('node:fs/promises');
    await cp(join(template,'portal/src'),join(directory,'src'),{recursive:true});
    const configPath=join(directory,'src/app-config.json');const config=JSON.parse(await readFile(configPath,'utf8'));
    config.appName=String(name).slice(0,80);config.footer.text=config.appName;config.logoText=config.appName.split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();
    await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
    await writeFile(join(directory,'README.md'),'# '+config.appName+"\n\nBIM-PORTAL v1: React, JavaScript, Tailwind, and Vite.\n\nOpen Vibe Coder manages App.jsx and src/studio/. Build screens under src/screens/ and shared components under src/components/. App name, logo, colors, footer, sign-in, and menu are configured in src/app-config.json. New screens are added to navigation automatically. Use Page and the UI components in src/studio/ui/components.jsx. usePortal from src/studio/ui/AppShell.jsx provides navigation and the optional signed-in user.\n\nNo sign-in or connection is required by default. Set authentication to supabase to use the existing Supabase connection for sign-in. Menu navigation does not enforce database permissions.\n\nIn Open Vibe Coder: edit files, submit a focused request, and rebuild. Outside the client: npm install, then npm run dev or npm run build. Keep .env out of Git; use public frontend settings only.\n");
  }
}

export async function ensureProjectConnections(directory, runtime) {
  const folder = join(directory, 'src/studio');
  await mkdir(folder, { recursive: true });
  if ((await lstat(join(directory, 'src'))).isSymbolicLink() || (await lstat(folder)).isSymbolicLink()) throw new Error("Symbolic links are not allowed.");
  for (const name of ['supabase.js', 'api.js']) {
    const path = join(folder, name);
    try { await writeFile(path, await readFile(join(template, name), 'utf8'), { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (!(await lstat(path)).isFile()) throw new Error("Invalid client file."); }
  }
  const example = "# Public frontend settings only. No secret keys.\nVITE_SUPABASE_URL=\nVITE_SUPABASE_PUBLISHABLE_KEY=\nVITE_API_BASE_URL=\n";
  try { await writeFile(join(directory, '.env.example'), example, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const ignorePath = join(directory, '.gitignore');
  let ignore = '';
  try { if (!(await lstat(ignorePath)).isFile()) throw new Error('Ongeldige .gitignore.'); ignore = await readFile(ignorePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const missing = ['node_modules/', 'dist/', '.cache/', '.env', '.env.*', '!.env.example'].filter(line => !ignore.split(/\r?\n/).includes(line));
  if (missing.length) await writeFile(ignorePath, ignore.trimEnd() + '\n' + missing.join('\n') + '\n');
  const packagePath = join(directory, 'package.json');
  if (!(await lstat(packagePath)).isFile()) throw new Error("Invalid package.json.");
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const deps = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).dependencies;
  if (pkg.dependencies?.['@supabase/supabase-js'] !== deps['@supabase/supabase-js']) {
    pkg.dependencies = { ...pkg.dependencies, '@supabase/supabase-js': deps['@supabase/supabase-js'] };
    await writeFile(packagePath, JSON.stringify(pkg, null, 2));
  }
}
