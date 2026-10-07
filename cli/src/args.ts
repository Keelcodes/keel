import { UsageError } from './errors.js';

/**
 * Parsed command-line arguments: positionals plus named options.
 *
 * Options are collected in order, so a repeated option keeps every value and
 * `get` returns the last one. The surface is deliberately tiny — the CLI has a
 * handful of flags and no need for a parser dependency.
 */
export interface ParsedArgs {
  readonly positionals: readonly string[];
  /** The last value given for `name`, or `undefined`. */
  get(name: string): string | undefined;
  /** Every value given for `name`, in order. */
  all(name: string): readonly string[];
  /** Whether `name` was given at all. */
  has(name: string): boolean;
  /** Whether the boolean `name` was given. */
  bool(name: string): boolean;
  /** Like `get`, but throws a {@link UsageError} when absent. */
  require(name: string): string;
  /** Parses `name` as an integer, or `undefined` when absent. */
  int(name: string): bigint | undefined;
}

class Args implements ParsedArgs {
  readonly positionals: readonly string[];
  private readonly values: Map<string, string[]>;

  constructor(values: Map<string, string[]>, positionals: readonly string[]) {
    this.values = values;
    this.positionals = positionals;
  }

  get(name: string): string | undefined {
    const list = this.values.get(name);
    return list === undefined ? undefined : list[list.length - 1];
  }

  all(name: string): readonly string[] {
    return this.values.get(name) ?? [];
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  bool(name: string): boolean {
    return this.get(name) === 'true';
  }

  require(name: string): string {
    const value = this.get(name);
    if (value === undefined) throw new UsageError(`missing required option --${name}`);
    return value;
  }

  int(name: string): bigint | undefined {
    const value = this.get(name);
    if (value === undefined) return undefined;
    try {
      return BigInt(value);
    } catch {
      throw new UsageError(`--${name} must be an integer, got "${value}"`);
    }
  }
}

/**
 * Parses argv in `--name value`, `--name=value` and `-n value` forms. Names in
 * `booleanFlags` take no value; `--` ends option parsing and everything after it
 * is positional.
 */
export function parseArgs(argv: readonly string[], booleanFlags: readonly string[] = []): ParsedArgs {
  const flags = new Set(booleanFlags);
  const values = new Map<string, string[]>();
  const positionals: string[] = [];

  const add = (name: string, value: string): void => {
    const list = values.get(name) ?? [];
    list.push(value);
    values.set(name, list);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    const long = token.startsWith('--') ? token.slice(2) : undefined;
    const short = long === undefined && token.startsWith('-') && token.length > 1 ? token.slice(1) : undefined;

    if (long === undefined && short === undefined) {
      positionals.push(token);
      continue;
    }

    const name = long ?? short!;
    const equals = name.indexOf('=');
    if (equals !== -1) {
      add(name.slice(0, equals), name.slice(equals + 1));
      continue;
    }
    if (flags.has(name)) {
      add(name, 'true');
      continue;
    }

    const next = argv[index + 1];
    // A leading dash is an option, not a value — except for `-` (stdin) and negative numbers.
    if (next === undefined || (next.startsWith('-') && next !== '-' && !/^-?\d/.test(next))) {
      throw new UsageError(`option ${long === undefined ? `-${name}` : `--${name}`} needs a value`);
    }
    add(name, next);
    index += 1;
  }

  return new Args(values, positionals);
}
