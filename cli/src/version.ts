import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface PackageJson {
  name?: string;
  version?: string;
}

/**
 * The CLI's own name and version, read from its `package.json` so the reported
 * version cannot drift from the published one.
 */
export function cliPackage(): { name: string; version: string } {
  const pkg = require('../package.json') as PackageJson;
  return { name: pkg.name ?? '@keelcodes/cli', version: pkg.version ?? '0.0.0' };
}
