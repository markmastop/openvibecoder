import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, cp, chmod, access, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { buildStudioUi } from './build-ui.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_VERSION = '22.22.2';

export function runtimeTarget(platform, arch) {
  const known = {
    'darwin-arm64': ['darwin-arm64', 'aarch64-apple-darwin', 'tar.gz'],
    'darwin-x64': ['darwin-x64', 'x86_64-apple-darwin', 'tar.gz'],
    'win32-x64': ['win-x64', 'x86_64-pc-windows-msvc', 'zip'],
  };
  if (!Object.hasOwn(known, `${platform}-${arch}`)) throw new Error("Desktop builds support macOS arm64/x64 and Windows x64. Use a supported target platform.");
  return known[`${platform}-${arch}`];
}

export function desktopTarget(env = process.env, platform = process.platform, arch = process.arch) {
  const triple = env.BIM_DESKTOP_TARGET || env.TAURI_ENV_TARGET_TRIPLE;
  const targets = { 'aarch64-apple-darwin':['darwin','arm64'], 'x86_64-apple-darwin':['darwin','x64'], 'x86_64-pc-windows-msvc':['win32','x64'] };
  if (!triple) { runtimeTarget(platform,arch); return {platform,arch}; }
  if (!Object.hasOwn(targets,triple)) throw new Error("Unknown desktop target. Use macOS arm64/x64 or Windows x64 MSVC.");
  return {platform:targets[triple][0],arch:targets[triple][1]};
}
export function verifyRuntimePackage(data, integrity) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-') || createHash('sha512').update(data).digest('base64') !== integrity.slice(7)) throw new Error("The platform package has an invalid SHA-512 checksum.");
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Official runtime download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function prepareBackend({ root, backend, platform = process.platform, arch = process.arch }) {
  await rm(backend, { recursive: true, force: true });
  await mkdir(backend, { recursive: true });
  // Expliciete lijst: geen .env, modelrapporten, npm-modules of andere projectbestanden bundelen.
  await writeFile(join(backend, 'build-info.json'), JSON.stringify({ version: JSON.parse(await readFile(join(root,'src-tauri/tauri.conf.json'),'utf8')).version, builtAt: new Date().toISOString() }));
  for (const name of ['src', 'templates', 'runtime/frontend', 'test/acceptance', 'runtime/specs', 'package.json']) {
    await cp(join(root, name), join(backend, name), { recursive: true, force: true, filter: source => { const normalized=source.split(sep).join('/'); const platformPackage=normalized.split('/node_modules/@esbuild/')[1]?.split('/')[0]; return !normalized.includes('/node_modules/.bin') && (!platformPackage || platformPackage === `${platform === 'win32' ? 'win32' : 'darwin'}-${arch}`); } });
  }
  // Pinned pure-JavaScript AST parser: no project plugins or runtime download.
  await mkdir(join(backend,'parser'), {recursive:true});
  await copyFile(join(root,'node_modules/prettier/plugins/babel.mjs'),join(backend,'parser/babel.mjs'));
  await copyFile(join(root,'node_modules/prettier/LICENSE'),join(backend,'parser/PRETTIER-LICENSE'));
}

async function main() {
  await buildStudioUi();
  const target = desktopTarget();
  const [distribution, triple, format] = runtimeTarget(target.platform, target.arch);
  if (target.platform === 'darwin' && process.platform !== 'darwin') throw new Error("Prepare a macOS bundle on macOS.");
  const cache = join(root, '.desktop-cache');
  const binaries = join(root, 'src-tauri', 'binaries');
  await mkdir(cache, { recursive: true }); await mkdir(binaries, { recursive: true });
  const folder = `node-v${NODE_VERSION}-${distribution}`;
  const archiveName = `${folder}.${format}`;
  const archivePath = join(cache, archiveName);
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const checksumPath = join(cache, `SHASUMS256-v${NODE_VERSION}.txt`);
  try { await access(checksumPath); } catch { await writeFile(checksumPath, await download(`${base}/SHASUMS256.txt`)); }
  const line = (await readFile(checksumPath, 'utf8')).split('\n').find(line => line.trim().endsWith(` ${archiveName}`));
  const expected = line?.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error("The official checksum list does not include this runtime.");
  try { await access(archivePath); } catch { await writeFile(archivePath, await download(`${base}/${archiveName}`)); }
  const actual = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  if (actual !== expected) throw new Error("The Node runtime has an invalid SHA-256 checksum; remove the cached file and try again.");
  if (format === 'zip' && process.platform !== 'win32') {
    execFileSync('/usr/bin/unzip', ['-q', '-o', archivePath, '-d', cache]);
  } else if (format === 'zip') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:BIM_NODE_ARCHIVE -DestinationPath $env:BIM_NODE_CACHE -Force'], {
      env: { ...process.env, BIM_NODE_ARCHIVE: archivePath, BIM_NODE_CACHE: cache }, stdio: 'inherit',
    });
  } else { execFileSync('/usr/bin/tar', ['-xzf', archivePath, '-C', cache]); }
  const executable = join(binaries, `bim-node-${triple}${target.platform === 'win32' ? '.exe' : ''}`);
  await copyFile(join(cache, folder, target.platform === 'win32' ? 'node.exe' : 'bin/node'), executable);
  await chmod(executable, 0o755);
  if (target.platform === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', join(root, 'src-tauri/Entitlements.plist'), executable]);
  }
  await access(join(root, 'runtime/frontend/node_modules/vite/package.json'));
  const backend = join(root, '.desktop-backend');
  await prepareBackend({ root, backend, ...target });
  // The host's npm install may contain only its own esbuild binary. Add the
  // exact target package from our lockfile without running npm install scripts.
  const platformPackage = `@esbuild/${target.platform === 'win32' ? 'win32' : 'darwin'}-${target.arch}`;
  const targetPackage = join(backend,'runtime/frontend/node_modules',platformPackage);
  try { await access(join(targetPackage,target.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild')); }
  catch {
    const lock=JSON.parse(await readFile(join(root,'runtime/frontend/package-lock.json'),'utf8'));
    const locked=lock.packages[`node_modules/${platformPackage}`];
    if(!locked?.resolved?.startsWith('https://registry.npmjs.org/@esbuild/')) throw new Error("Platform package missing from the pinned lockfile.");
    const archive=await download(locked.resolved); verifyRuntimePackage(archive,locked.integrity);
    const packageArchive=join(cache,`esbuild-${target.platform}-${target.arch}-${locked.version}.tgz`);
    await writeFile(packageArchive,archive); await mkdir(targetPackage,{recursive:true});
    const tar=process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar';
    execFileSync(tar,['-xzf',packageArchive,'--strip-components=1','-C',targetPackage]);
    await access(join(targetPackage,target.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'));
  }
  if (target.platform === 'darwin') {
    async function signRuntime(folder) {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await signRuntime(path);
        else if (entry.isFile() && (entry.name.endsWith('.node') || entry.name === 'esbuild')) {
          execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', path]);
        }
      }
    }
    await signRuntime(join(backend, 'runtime/frontend/node_modules'));
  }
  await copyFile(join(cache, folder, 'LICENSE'), join(backend, 'NODE-LICENSE.txt'));
  await writeFile(join(backend, 'runtime.json'), JSON.stringify({ nodeVersion: NODE_VERSION, distribution, triple, archiveSha256: actual }, null, 2));
  console.log(`Desktop prepared: Node ${NODE_VERSION}, ${triple}; only trusted backend files included.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
