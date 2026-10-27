import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The source tree is preserved in development and in the desktop backend bundle.
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeDirectory = join(packageRoot, 'runtime/frontend');
export const uiDirectory = join(packageRoot, 'build/ui');
export const specsDirectory = join(packageRoot, 'runtime/specs');
export const acceptanceFile = join(packageRoot, 'test/acceptance/hr-backend.mjs');
export function runPath(dataRoot, ...parts) {
  const directory = resolve(dataRoot) === packageRoot
    ? join(packageRoot, '.local/runs')
    : join(dataRoot, 'runs');
  return join(directory, ...parts);
}

export function projectsDirectory(dataRoot) {
  return resolve(dataRoot) === packageRoot ? join(packageRoot, '.local/projects') : join(dataRoot, 'projects');
}
