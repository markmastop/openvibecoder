import { runPath } from '../paths.mjs';
import { mkdir, readFile, writeFile, realpath, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function workspaceName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f/\\]/.test(value)) throw new Error("Use a project name of 1–80 characters without slashes.");
  const name = value.trim();
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  if (!slug || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(slug)) throw new Error("Choose a different project name.");
  return { name, slug };
}
export async function projectDestination(path) {
  const absolute = resolve(path);
  try {
    if ((await lstat(absolute)).isSymbolicLink() || !(await lstat(absolute)).isDirectory()) throw new Error("Choose a regular project directory.");
    return await realpath(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(await realpath(resolve(absolute, '..')), absolute.split(/[\\/]/).pop());
  }
}
export async function workspacePlan(name, location, selected = false) {
  const identity = workspaceName(name);
  // Native location selection already includes the final folder name.
  if (!selected) await mkdir(location, { recursive: true });
  const target = selected ? location : join(location, identity.slug);
  return { ...identity, directory: await projectDestination(target) };
}
export async function createWorkspace(root, id, name, location, selected = false, expectedPath) {
  if (!selected) await mkdir(location, { recursive: true });
  const identity = await workspacePlan(name, location, selected);
  const directory = identity.directory;
  if (expectedPath !== undefined && expectedPath !== directory) throw Object.assign(new Error("The project location changed. Check the location again."), { code: 'LOCATION_CHANGED' });
  try { await mkdir(directory); } catch (error) {
    if (error.code !== 'EEXIST' || !selected || (await readdir(directory)).length) throw error;
  }
  const metadata = { version: 1, id, name: identity.name, template: 'react-tailwind', createdAt: new Date().toISOString() };
  await writeFile(join(directory, '.bim-studio.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
  await writeFile(runPath(root, id, '.workspace.json'), JSON.stringify({ directory }, null, 2), { flag: 'wx' });
  return { ...identity, directory };
}
export async function workspaceDirectory(root, id) {
  const registry = runPath(root, id, '.workspace.json');
  try {
    if ((await lstat(registry)).isSymbolicLink()) throw new Error("Invalid project registration.");
    const { directory } = JSON.parse(await readFile(registry, 'utf8'));
    if (typeof directory !== 'string' || resolve(directory) !== directory || (await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error("The project directory was moved or is invalid.");
    const marker = join(directory, '.bim-studio.json');
    if ((await lstat(marker)).isSymbolicLink() || JSON.parse(await readFile(marker, 'utf8')).id !== id) throw new Error("This directory does not belong to this project.");
    return directory;
  } catch (error) {
    if (error.code === 'ENOENT') {
      // A registered project must never silently fall back to a different folder.
      try { await lstat(registry); } catch (missing) { if (missing.code === 'ENOENT') return runPath(root, id, 'project'); }
    }
    throw error;
  }
}
