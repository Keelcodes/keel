import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.js';
import { parsePolicyInput } from './commands.js';
import { UsageError } from './errors.js';
import type { CliIo } from './io.js';
import { runCli } from './run.js';

const TOKEN = '0x0000000000000000000000000000000000000001';
const OTHER = '0x0000000000000000000000000000000000000002';

const POLICY = JSON.stringify({
  rules: [
    { target: TOKEN, maxPerTx: '1000', maxDaily: '0' },
    { target: OTHER, selectors: [], maxCalls: 3 },
  ],
});

const REGISTRY = JSON.stringify({
  defaultVersion: 'v2',
  modules: [
    { version: 'v1', encoding: 'payload', multiSession: false, enforcedLimits: false },
    { version: 'v2', encoding: 'onchain', multiSession: true, enforcedLimits: true },
  ],
});

function fakeIo(files: Record<string, string> = {}, env: Record<string, string> = {}): CliIo & {
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    readText: async (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`no such file: ${path}`);
      return value;
    },
    readStdin: async () => files['-'] ?? '',
    env,
  };
}

describe('parseArgs', () => {
  it('collects positionals and named options', () => {
    const args = parseArgs(['policy', 'check', '--policy', 'p.json', '--target=x']);
    expect(args.positionals).toEqual(['policy', 'check']);
    expect(args.get('policy')).toBe('p.json');
    expect(args.get('target')).toBe('x');
  });

  it('keeps every value of a repeated option, returning the last', () => {
    const args = parseArgs(['--data', '0xaa', '--data', '0xbb']);
    expect(args.all('data')).toEqual(['0xaa', '0xbb']);
    expect(args.get('data')).toBe('0xbb');
  });

  it('treats declared boolean flags as valueless', () => {
    const args = parseArgs(['--json'], ['json']);
    expect(args.bool('json')).toBe(true);
  });

  it('stops option parsing at --', () => {
    const args = parseArgs(['--json', '--', '--not-an-option'], ['json']);
    expect(args.positionals).toEqual(['--not-an-option']);
  });

  it('accepts a negative number as a value', () => {
    expect(parseArgs(['--at', '-1']).int('at')).toBe(-1n);
  });

  it('rejects an option with no value', () => {
    expect(() => parseArgs(['--policy', '--json'])).toThrow(UsageError);
  });
});

describe('runCli', () => {
  it('prints help for no command and for `help`', async () => {
    const empty = fakeIo();
    expect(await runCli([], empty)).toBe(0);
    expect(empty.stdout.join('\n')).toContain('Commands:');

    const help = fakeIo();
    expect(await runCli(['help'], help)).toBe(0);
    expect(help.stdout.join('\n')).toContain('Commands:');
  });

  it('prints the version from package.json', async () => {
    const io = fakeIo();
    expect(await runCli(['version'], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('@keelcodes/cli');
  });

  it('fails an unknown command with a usage error', async () => {
    const io = fakeIo();
    expect(await runCli(['nope'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('unknown command "nope"');
  });
});

describe('policy check', () => {
  it('describes a policy without a target', async () => {
    const io = fakeIo({ 'p.json': POLICY });
    expect(await runCli(['policy', 'check', '--policy', 'p.json'], io)).toBe(0);
    const output = io.stdout.join('\n');
    expect(output).toMatch(/policy 0x[0-9a-f]{64}/);
    expect(output).toContain(`rule 0: target=${TOKEN}`);
  });

  it('allows a call inside the cap', async () => {
    const io = fakeIo({ 'p.json': POLICY });
    const code = await runCli(['policy', 'check', '--policy', 'p.json', '--target', TOKEN, '--value', '500'], io);
    expect(code).toBe(0);
    expect(io.stdout.join('\n')).toContain('allow rule=0');
  });

  it('denies a call over the cap with exit code 1', async () => {
    const io = fakeIo({ 'p.json': POLICY });
    const code = await runCli(['policy', 'check', '--policy', 'p.json', '--target', TOKEN, '--value', '2000'], io);
    expect(code).toBe(1);
    expect(io.stdout.join('\n')).toContain('deny reason=value-per-tx-exceeded rule=0');
  });

  it('denies a call to an unknown target', async () => {
    const io = fakeIo({ 'p.json': POLICY });
    const code = await runCli(
      ['policy', 'check', '--policy', 'p.json', '--target', '0x0000000000000000000000000000000000000009'],
      io,
    );
    expect(code).toBe(1);
    expect(io.stdout.join('\n')).toContain('no-matching-rule');
  });

  it('emits JSON when asked', async () => {
    const io = fakeIo({ 'p.json': POLICY });
    expect(await runCli(['policy', 'check', '--policy', 'p.json', '--json'], io)).toBe(0);
    const parsed = JSON.parse(io.stdout.join('\n')) as { commitment: string; policy: { rules: unknown[] } };
    expect(parsed.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(parsed.policy.rules).toHaveLength(2);
  });

  it('reads the policy from stdin', async () => {
    const io = fakeIo({ '-': POLICY });
    expect(await runCli(['policy', 'check', '--policy', '-'], io)).toBe(0);
  });

  it('fails a malformed policy with exit code 1', async () => {
    const io = fakeIo({ 'p.json': JSON.stringify({ rules: [{ target: 'not-an-address' }] }) });
    expect(await runCli(['policy', 'check', '--policy', 'p.json'], io)).toBe(1);
    expect(io.stderr.join('\n')).toContain('error:');
  });

  it('fails a missing required option with a usage error', async () => {
    const io = fakeIo();
    expect(await runCli(['policy', 'check'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('missing required option --policy');
  });
});

describe('migrate route', () => {
  it('routes a version-less session to the default generation', async () => {
    const io = fakeIo({ 'r.json': REGISTRY });
    expect(await runCli(['migrate', 'route', '--registry', 'r.json', '--id', 's-1'], io)).toBe(0);
    expect(io.stdout.join('\n')).toContain('→ v2');
  });

  it('routes a versioned session to its generation', async () => {
    const io = fakeIo({ 'r.json': REGISTRY });
    const code = await runCli(
      ['migrate', 'route', '--registry', 'r.json', '--id', 's-2', '--module-version', 'v1', '--json'],
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdout.join('\n')) as { module: { version: string } };
    expect(parsed.module.version).toBe('v1');
  });

  it('fails an unknown module version with exit code 1', async () => {
    const io = fakeIo({ 'r.json': REGISTRY });
    expect(
      await runCli(['migrate', 'route', '--registry', 'r.json', '--id', 's-3', '--module-version', 'v9'], io),
    ).toBe(1);
    expect(io.stderr.join('\n')).toContain('unregistered module version v9');
  });
});

describe('conformance', () => {
  it('lists the suites', async () => {
    const io = fakeIo();
    expect(await runCli(['conformance', 'list'], io)).toBe(0);
    const output = io.stdout.join('\n');
    expect(output).toContain('ERC-7579');
    expect(output).toContain('ERC-8004');
  });

  it('requires an RPC URL to run', async () => {
    const io = fakeIo();
    expect(await runCli(['conformance', 'run'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('--rpc');
  });

  it('accepts the RPC URL from the environment', async () => {
    const io = fakeIo({}, { KEEL_RPC_URL: 'http://localhost:8545' });
    // No --suite-required flags are given, so this fails on the target, not on RPC.
    expect(await runCli(['conformance', 'run', '--suite', 'erc7579'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('--account');
  });

  it('refuses a suite the CLI cannot wire', async () => {
    const io = fakeIo({}, { KEEL_RPC_URL: 'http://localhost:8545' });
    expect(await runCli(['conformance', 'run', '--suite', 'erc7715'], io)).toBe(2);
    expect(io.stderr.join('\n')).toContain('wallet provider');
  });
});

describe('parsePolicyInput', () => {
  it('converts decimal strings to bigints and validates booleans later', () => {
    const input = parsePolicyInput(JSON.parse(POLICY));
    expect(input.rules[0]?.maxPerTx).toBe(1000n);
    expect(input.rules[0]?.maxDaily).toBe(0n);
    expect(input.rules[1]?.maxCalls).toBe(3);
  });

  it('rejects a non-array rules field', () => {
    expect(() => parsePolicyInput({ rules: {} })).toThrow('policy.rules: expected an array');
  });
});
