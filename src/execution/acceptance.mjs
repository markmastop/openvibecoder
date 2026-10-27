export function acceptancePassed(result, expectedNames) {
  if (!result.passed || expectedNames.length !== 18) return false;
  const passed = [...result.output.matchAll(/^ok \d+ - (.+)$/gm)].map(match => match[1]);
  return expectedNames.every(name => passed.includes(name)) && passed.length === 18
    && /^# tests 18$/m.test(result.output) && /^# pass 18$/m.test(result.output)
    && /^# fail 0$/m.test(result.output) && /^# cancelled 0$/m.test(result.output)
    && /^# skipped 0$/m.test(result.output);
}
