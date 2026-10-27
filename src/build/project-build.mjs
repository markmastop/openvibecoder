import {validatePortalConfig} from '../projects/portal-project.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, realpath, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
import { runtimeDirectory } from '../paths.mjs';
export { runtimeDirectory };
export async function buildProject(directory, { signal, node = process.execPath } = {}) {
  directory = await realpath(directory);
  node = await realpath(node);
  if (process.platform !== 'darwin') throw new Error("Sandboxed builds are currently available on macOS. Windows build isolation is not yet available.");
  async function inspect(folder) {
    for (const entry of await readdir(folder, {withFileTypes:true})) {
      if (entry.isSymbolicLink()) throw new Error("Symbolic links are not allowed in source code.");
      const path = join(folder,entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith('.css') && /@(config|plugin)\b/.test(await readFile(path,'utf8'))) throw new Error("Open Vibe Coder manages the Tailwind configuration and plugins.");
    }
  }
  await inspect(join(directory,'src'));
  const entry=await readFile(join(directory,'src/App.jsx'),'utf8');
  if(entry.includes('// BIM-APP-SHELL v1')){
    const config=JSON.parse(await readFile(join(directory,'src/app-config.json'),'utf8'));
    const paths=new Set((await readdir(join(directory,'src/screens'))).map(name=>'src/screens/'+name));
    validatePortalConfig(config,paths);
  }
  await mkdir(join(directory, 'dist'), { recursive: true });
  await mkdir(join(directory, '.cache'), { recursive: true });
  const quote = JSON.stringify;
  const worker = join(here, 'project-build-worker.mjs');
  const binary = join(runtimeDirectory, 'node_modules/@esbuild', `darwin-${process.arch}`, 'bin/esbuild');
  const profile = `(version 1)(deny default)
(allow process-fork)(allow process-exec (literal ${quote(node)}) (literal ${quote(binary)}))
(allow file-read-metadata)(allow sysctl-read)(allow mach-lookup)
(allow file-read-data (literal "/") (subpath "/System") (subpath "/usr") (subpath "/opt/homebrew") (subpath "/Library/Apple") (literal "/dev/null") (literal "/dev/urandom") (subpath ${quote(dirname(node))}) (literal ${quote(worker)}) (literal ${quote(join(here, '../projects/project-settings.mjs'))}) (subpath ${quote(runtimeDirectory)}) (subpath ${quote(directory)}))
(allow file-write* (subpath ${quote(join(directory, 'dist'))}) (subpath ${quote(join(directory, '.cache'))}))`;
  await writeFile(join(directory, '.cache/build.sb'), profile);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', join(directory, '.cache/build.sb'), node, worker, directory, runtimeDirectory], { cwd: directory, env: { PATH: dirname(node) + ':/usr/bin:/bin', HOME: join(directory, '.cache'), TMPDIR: join(directory, '.cache'), LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-80_000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 60_000);
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', async code => { clearTimeout(timer); signal?.removeEventListener('abort', stop); await writeFile(join(directory, 'build.log'), output); resolve({ passed: code === 0 && !signal?.aborted, output }); });
    if (signal?.aborted) stop();
  });
}
