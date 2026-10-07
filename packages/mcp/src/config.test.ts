import { describe, expect, it } from 'vitest';
import { ConfigError, readEnvConfig } from './config.js';

const TOKEN = '0x0000000000000000000000000000000000000001';

function policyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ rules: [{ target: TOKEN, maxPerTx: '1000' }], ...overrides });
}

const neverRead = (): string => {
  throw new Error('readFile should not be called for an inline policy');
};

describe('readEnvConfig', () => {
  it('parses an inline policy and normalises it', () => {
    const config = readEnvConfig({ KEEL_POLICY: policyJson() }, neverRead);
    expect(config.policy.rules).toHaveLength(1);
    expect(config.policy.rules[0]!.target).toBe(TOKEN);
    expect(config.policy.rules[0]!.maxPerTx).toBe(1000n);
    expect(config.policySource).toBe('KEEL_POLICY (inline)');
    expect(config.executor).toBeUndefined();
  });

  it('reads the policy from a file when the value starts with "@"', () => {
    const config = readEnvConfig({ KEEL_POLICY: '@/etc/keel/policy.json' }, (path) => {
      expect(path).toBe('/etc/keel/policy.json');
      return policyJson();
    });
    expect(config.policySource).toBe('/etc/keel/policy.json');
    expect(config.policy.rules[0]!.target).toBe(TOKEN);
  });

  it('raises a ConfigError when no policy is configured', () => {
    expect(() => readEnvConfig({}, neverRead)).toThrow(ConfigError);
    expect(() => readEnvConfig({ KEEL_POLICY: '   ' }, neverRead)).toThrow(/no policy configured/);
  });

  it('names the source when the document is not valid JSON', () => {
    expect(() => readEnvConfig({ KEEL_POLICY: '{' }, neverRead)).toThrow(/not valid JSON/);
    expect(() => readEnvConfig({ KEEL_POLICY: '@broken.json' }, () => '{')).toThrow(/broken\.json/);
  });

  it('reports the path of a malformed rule', () => {
    expect(() => readEnvConfig({ KEEL_POLICY: JSON.stringify({ rules: [] }) }, neverRead)).toThrow(
      /"rules" must be a non-empty array/,
    );
    expect(() =>
      readEnvConfig({ KEEL_POLICY: JSON.stringify({ rules: [{ maxPerTx: '1' }] }) }, neverRead),
    ).toThrow(/rules\[0\]\.target/);
  });

  it('rejects a negative or non-integer amount with a located message', () => {
    expect(() =>
      readEnvConfig({ KEEL_POLICY: JSON.stringify({ rules: [{ target: TOKEN, maxPerTx: '-5' }] }) }, neverRead),
    ).toThrow(/rules\[0\]\.maxPerTx/);
    expect(() =>
      readEnvConfig({ KEEL_POLICY: JSON.stringify({ rules: [{ target: TOKEN, maxCalls: 1.5 }] }) }, neverRead),
    ).toThrow(/rules\[0\]\.maxCalls/);
  });

  it('surfaces an unreadable policy file as a ConfigError', () => {
    expect(() =>
      readEnvConfig({ KEEL_POLICY: '@/missing.json' }, () => {
        throw new Error('ENOENT: no such file');
      }),
    ).toThrow(/cannot read "\/missing\.json"/);
  });

  it('reads the executor endpoint and its bearer token', () => {
    const config = readEnvConfig(
      {
        KEEL_POLICY: policyJson(),
        KEEL_EXECUTOR_URL: ' https://executor.keel.codes ',
        KEEL_EXECUTOR_TOKEN: 's3cret',
      },
      neverRead,
    );
    expect(config.executor).toEqual({ url: 'https://executor.keel.codes', token: 's3cret' });
  });

  it('omits the token when only the URL is set', () => {
    const config = readEnvConfig(
      { KEEL_POLICY: policyJson(), KEEL_EXECUTOR_URL: 'http://127.0.0.1:8080' },
      neverRead,
    );
    expect(config.executor).toEqual({ url: 'http://127.0.0.1:8080' });
  });

  it('rejects a non-http executor URL', () => {
    expect(() =>
      readEnvConfig({ KEEL_POLICY: policyJson(), KEEL_EXECUTOR_URL: 'executor.keel.codes' }, neverRead),
    ).toThrow(/expected an http\(s\) URL/);
  });
});
