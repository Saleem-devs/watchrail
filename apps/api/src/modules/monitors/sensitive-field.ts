const sensitiveFieldNames = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'session',
  'sessionid',
  'token',
]);

export function isSensitiveFieldName(name: string): boolean {
  return sensitiveFieldNames.has(name.replace(/[^a-z0-9]/giu, '').toLowerCase());
}
