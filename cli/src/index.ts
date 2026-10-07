/**
 * @keelcodes/cli
 *
 * The `keel` command line: the three checks an operator runs by hand, made
 * scriptable.
 *
 * - `keel policy check` — normalise an authored policy, print its commitment and
 *   dry-run a call against it, so a mis-scoped policy is caught before it is
 *   signed rather than after.
 * - `keel migrate route` — route a session record to its module generation using
 *   a registry descriptor, the same routing the relay uses.
 * - `keel conformance run` — run an ERC-7579 / 7710 / 8004 conformance suite
 *   against a live chain and report per-assertion pass/fail.
 *
 * Commands are written against the {@link CliIo} port, so they run identically
 * under `bin.ts` and under a test.
 *
 * @packageDocumentation
 */

export { parseArgs } from './args.js';
export type { ParsedArgs } from './args.js';
export { parsePolicyInput } from './commands.js';
export { UsageError } from './errors.js';
export { createNodeIo, readInput } from './io.js';
export type { CliIo } from './io.js';
export { runCli, usage } from './run.js';
export { cliPackage } from './version.js';
