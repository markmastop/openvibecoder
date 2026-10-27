export function redact(value, secrets = []) {
  let result = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result;
}
