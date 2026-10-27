import {readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
export async function desktopVersion(root, {increment = true} = {}) {
  const paths=['package.json','package-lock.json','src-tauri/tauri.conf.json','src-tauri/Cargo.toml','src-tauri/Cargo.lock'];
  const texts=await Promise.all(paths.map(path=>readFile(join(root,path),'utf8')));
  const pkg=JSON.parse(texts[0]), lock=JSON.parse(texts[1]), config=JSON.parse(texts[2]);
  const cargo=texts[3].match(/^version = "([^"]+)"$/m);
  const cargoLock=texts[4].match(/\[\[package\]\]\r?\nname = "bim-studio"\r?\nversion = "([^"]+)"/);
  const versions=[pkg.version,lock.version,lock.packages?.['']?.version,config.version,cargo?.[1],cargoLock?.[1]];
  if(!/^\d+\.\d+\.\d+$/.test(pkg.version)||versions.some(v=>v!==pkg.version))throw new Error("Versions in npm, Tauri, and Cargo do not match. Nothing was changed.");
  if(!increment)return pkg.version;
  const parts=pkg.version.split('.').map(Number);
  if(parts.some(n=>!Number.isSafeInteger(n))||!Number.isSafeInteger(parts[2]+1))throw new Error("Invalid version number.");
  parts[2]++; const version=parts.join('.');
  pkg.version=version;lock.version=version;lock.packages[''].version=version;config.version=version;
  const next=[JSON.stringify(pkg,null,2)+'\n',JSON.stringify(lock,null,2)+'\n',JSON.stringify(config,null,2)+'\n',texts[3].replace(/^version = "[^"]+"$/m,`version = "${version}"`),texts[4].replace(/(\[\[package\]\]\r?\nname = "bim-studio"\r?\nversion = ")[^"]+("\r?\n)/,(_,before,after)=>before+version+after)];
  // Validate everything first; replace each manifest with a completely written file.
  for(let i=0;i<paths.length;i++)await writeFile(join(root,paths[i]+'.version-tmp'),next[i]);
  for(const path of paths)await rename(join(root,path+'.version-tmp'),join(root,path));
  return version;
}
