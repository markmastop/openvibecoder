export function cleanEnvironment(env = process.env) {
  // Modelcode krijgt geen modelsleutel of overige accountconfiguratie mee.
  return Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(key => env[key]).map(key => [key, env[key]]));
}

const quote = value => JSON.stringify(value);
export function sandboxProfile({ runDir, nodeDir, nodePath, appDir, stateDir }) {
  return `(version 1)
(deny default)
(allow process-exec (literal ${quote(nodePath || nodeDir + '/bin/node')}))
(allow process-fork)
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read-data (subpath "/System") (subpath "/usr") (subpath "/Library/Apple") (subpath "/opt/homebrew") (literal "/dev/null") (literal "/dev/urandom") (subpath ${quote(nodeDir)}) (subpath ${quote(runDir)}))
(allow file-write* (subpath ${quote(appDir)}) (subpath ${quote(stateDir)}))
(allow sysctl-read)
(allow mach-lookup)
`;
}
