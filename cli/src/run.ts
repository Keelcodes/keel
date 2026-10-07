import { parseArgs } from './args.js';
import {
  conformanceList,
  conformanceRun,
  migrateRoute,
  policyCheck,
  versionCommand,
} from './commands.js';
import { UsageError } from './errors.js';
import type { CliIo } from './io.js';

const USAGE = [
  'keel <command> [options]',
  '',
  'Commands:',
  '  version',
  '      Print the CLI version.',
  '',
  '  policy check --policy <file|-> [--target <addr>] [--value <wei>] [--data <hex>] [--at <unix>] [--json]',
  '      Normalise a policy and print its commitment; with --target, dry-run a call.',
  '',
  '  migrate route --registry <file|-> --id <id> [--module-version <v>] [--json]',
  '      Route a session to its module generation.',
  '',
  '  conformance list [--json]',
  '      List the conformance suites.',
  '',
  '  conformance run --rpc <url> [--suite <name>] [--json] [suite options]',
  '      Run a suite against a live chain. --suite defaults to erc7579.',
  '      erc7579: --account <addr> --module <addr> [--type <uint>]',
  '      erc7710: --manager <addr>',
  '      erc8004: --identity-registry <addr> --agent-id <uint> [--reputation-registry <addr>]',
  '',
  'Options may be written --name value, --name=value or -n value. `-` reads stdin.',
].join('\n');

/** The CLI's help text. */
export function usage(): string {
  return USAGE;
}

const BOOLEAN_FLAGS = ['json', 'help'];

/**
 * Runs the CLI and returns its exit code: 0 on success, 1 when the subject
 * itself failed (a denied call, a failing suite), 2 on a usage error.
 *
 * Never throws — mapping errors to a printed message and a code keeps `bin.ts`
 * a two-line wrapper and makes the whole surface testable without a process.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const args = parseArgs(argv, BOOLEAN_FLAGS);
    const [command, subcommand] = args.positionals;

    if (args.bool('help') || command === undefined || command === 'help') {
      io.out(USAGE);
      return 0;
    }

    switch (command) {
      case 'version':
        return versionCommand(args, io);
      case 'policy':
        if (subcommand === 'check') return await policyCheck(args, io);
        throw new UsageError(`unknown policy subcommand "${subcommand ?? ''}"; expected "check"`);
      case 'migrate':
        if (subcommand === 'route') return await migrateRoute(args, io);
        throw new UsageError(`unknown migrate subcommand "${subcommand ?? ''}"; expected "route"`);
      case 'conformance':
        if (subcommand === 'list') return conformanceList(args, io);
        if (subcommand === 'run') return await conformanceRun(args, io);
        throw new UsageError(`unknown conformance subcommand "${subcommand ?? ''}"; expected "run" or "list"`);
      default:
        throw new UsageError(`unknown command "${command}"; run "keel help"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`error: ${error.message}`);
      io.err(USAGE);
      return error.exitCode;
    }
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
