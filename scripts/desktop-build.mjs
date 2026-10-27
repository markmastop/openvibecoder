import {mkdir,open,readFile,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {desktopVersion} from './desktop-version.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const keep=args.includes('--keep-version')||args.includes('--help')||args.includes('-h');
const cache=join(root,'.desktop-cache');await mkdir(cache,{recursive:true});
const path=join(cache,'desktop-build.lock');
let lock;
try {lock=await open(path,'wx');}
catch(error) {
  if(error.code!=='EEXIST')throw error;
  // A terminated build must not leave the build command permanently locked.
  let pid;try{pid=JSON.parse(await readFile(path,'utf8')).pid;}catch{}
  if(!Number.isInteger(pid))throw new Error("Invalid build lock. Check whether a build is running.");
  try{process.kill(pid,0);throw new Error("A desktop build is already running. Wait for it to finish.");}
  catch(probe){if(probe.code!=='ESRCH')throw probe;}
  await unlink(path);lock=await open(path,'wx');
}
try {
  await lock.writeFile(JSON.stringify({pid:process.pid}));
  const version=await desktopVersion(root,{increment:!keep});
  console.log(`Open Vibe Coder ${version}${keep?" · existing release version":" · patch version incremented automatically"}`);
  // Invoke the installed CLI directly: no shell or command-string interpolation.
  const cli=join(root,'node_modules/@tauri-apps/cli/tauri.js');
  const child=spawn(process.execPath,[cli,'build',...args.filter(arg=>arg!=='--keep-version')],{cwd:root,env:process.env,stdio:'inherit'});
  const stop=()=>child.kill('SIGTERM');process.once('SIGINT',stop);process.once('SIGTERM',stop);
  process.exitCode=await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',code=>done(code??1));});
  process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
} finally {await lock.close();await unlink(path);}
