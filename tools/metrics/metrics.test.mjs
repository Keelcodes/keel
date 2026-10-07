import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressTopic,
  badgeDefinitions,
  buildSnapshot,
  CHAINS,
  contributorCount,
  formatCount,
  mergeChainScan,
  npmWeeklyDownloads,
  parseRepo,
  renderBadge,
  renderMarkdown,
  searchTotal,
  sessionAccounts,
  sumDownloads,
  summarizeRepo,
  topicAddress,
} from './lib.mjs';

test('parseRepo accepts slug, URL and .git suffix', () => {
  assert.deepEqual(parseRepo('Keelcodes/keel'), { owner: 'Keelcodes', name: 'keel', slug: 'Keelcodes/keel' });
  assert.equal(parseRepo('https://github.com/Keelcodes/keel').slug, 'Keelcodes/keel');
  assert.equal(parseRepo('Keelcodes/keel.git').name, 'keel');
});

test('parseRepo rejects anything that is not a repository', () => {
  assert.throws(() => parseRepo('not a repo'), /not a GitHub repository/);
  assert.throws(() => parseRepo(''), /not a GitHub repository/);
});

test('summarizeRepo maps the counters and nulls the missing ones', () => {
  const summary = summarizeRepo({
    stargazers_count: 12,
    forks_count: 3,
    subscribers_count: 4,
    open_issues_count: 5,
  });
  assert.deepEqual(summary, { stars: 12, forks: 3, watchers: 4, openIssuesAndPrs: 5 });
  assert.deepEqual(summarizeRepo({}), { stars: null, forks: null, watchers: null, openIssuesAndPrs: null });
  assert.deepEqual(summarizeRepo(null), { stars: null, forks: null, watchers: null, openIssuesAndPrs: null });
});

test('contributorCount prefers the Link rel=last page, else the page length', () => {
  const link = '<https://api.github.com/repos/x/y/contributors?per_page=1&page=42>; rel="last"';
  assert.equal(contributorCount(link, 1), 42);
  assert.equal(contributorCount(null, 1), 1);
  assert.equal(contributorCount(undefined, 0), 0);
});

test('searchTotal reads total_count, else null', () => {
  assert.equal(searchTotal({ total_count: 7 }), 7);
  assert.equal(searchTotal({}), null);
  assert.equal(searchTotal(null), null);
});

test('npmWeeklyDownloads keeps "not published" distinct from zero', () => {
  assert.equal(npmWeeklyDownloads({ downloads: 0 }), 0);
  assert.equal(npmWeeklyDownloads({ downloads: 128 }), 128);
  assert.equal(npmWeeklyDownloads({}), null);
  assert.equal(npmWeeklyDownloads(null), null);
});

test('sumDownloads sums known values and returns null when none are known', () => {
  assert.equal(sumDownloads({ a: 3, b: 4 }), 7);
  assert.equal(sumDownloads({ a: 3, b: null }), 3);
  assert.equal(sumDownloads({}), null);
  assert.equal(sumDownloads({ a: null }), null);
});

test('formatCount compacts thousands and millions, and passes TBD through', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1k');
  assert.equal(formatCount(1234), '1.2k');
  assert.equal(formatCount(1_000_000), '1M');
  assert.equal(formatCount(null), 'TBD');
  assert.equal(formatCount(undefined), 'TBD');
});

test('topicAddress reads the address out of an indexed topic, and rejects junk', () => {
  const topic = '0x0000000000000000000000005C256B63898D845e20De793b20a296c08517f314';
  assert.equal(topicAddress(topic), '0x5c256b63898d845e20de793b20a296c08517f314');
  assert.equal(topicAddress('0x1234'), null);
  assert.equal(topicAddress(undefined), null);
});

test('addressTopic is the inverse of topicAddress', () => {
  const address = '0x5C256B63898D845e20De793b20a296c08517f314';
  assert.equal(topicAddress(addressTopic(address)), address.toLowerCase());
});

test('sessionAccounts dedupes and sorts the indexed accounts', () => {
  const log = (account) => ({ topics: ['0x' + 'aa'.repeat(32), addressTopic(account)] });
  const accounts = sessionAccounts([log('0xAbC0000000000000000000000000000000000001'), log('0xabc0000000000000000000000000000000000001'), log('0x0000000000000000000000000000000000000002')]);
  assert.deepEqual(accounts, ['0x0000000000000000000000000000000000000002', '0xabc0000000000000000000000000000000000001']);
});

test('mergeChainScan accumulates counters and advances the cursor', () => {
  const chain = CHAINS.find((entry) => entry.key === 'bsc');
  const first = mergeChainScan(chain, undefined, {
    sessionLogs: [{ topics: ['0x' + 'aa'.repeat(32), addressTopic('0x0000000000000000000000000000000000000001')] }],
    userOpLogs: [{}, {}],
    cursorBlock: 100,
  });
  assert.deepEqual(first, {
    id: chain.id,
    key: 'bsc',
    name: 'BSC',
    cursorBlock: 100,
    accounts: ['0x0000000000000000000000000000000000000001'],
    installs: 1,
    userops: 2,
  });

  const second = mergeChainScan(chain, first, {
    sessionLogs: [],
    userOpLogs: [{}],
    cursorBlock: 200,
  });
  assert.equal(second.cursorBlock, 200);
  assert.equal(second.installs, 1);
  assert.equal(second.userops, 3);
  assert.deepEqual(second.accounts, first.accounts);
});

function snapshotFixture(overrides = {}) {
  return buildSnapshot({
    generatedAt: '2026-10-04T00:00:00.000Z',
    repo: parseRepo('Keelcodes/keel'),
    values: {
      stars: 12,
      forks: 3,
      watchers: 4,
      contributors: 2,
      mergedPrs: 9,
      openIssues: 5,
      ...overrides,
    },
    npm: { '@keelcodes/policy': 128, '@keelcodes/migrate': null },
  });
}

test('buildSnapshot marks unknown metrics TBD rather than zero', () => {
  const snapshot = snapshotFixture({ stars: null });
  const stars = snapshot.metrics.find((metric) => metric.id === 'github.stars');
  assert.equal(stars.value, null);
  assert.equal(stars.display, 'TBD');
  assert.equal(snapshot.metrics.find((metric) => metric.id === 'github.forks').display, '3');
  assert.equal(snapshot.metrics.find((metric) => metric.id === 'npm.downloads').display, '128');
});

test('buildSnapshot lists packages sorted and nothing left unwired', () => {
  const snapshot = snapshotFixture();
  assert.deepEqual(
    snapshot.packages.map((pkg) => pkg.name),
    ['@keelcodes/migrate', '@keelcodes/policy'],
  );
  assert.equal(snapshot.packages.find((pkg) => pkg.name === '@keelcodes/migrate').weeklyDownloads, null);
  assert.equal(snapshot.pending.length, 0);
});

test('buildSnapshot wires telemetry, site analytics and adopters', () => {
  const snapshot = buildSnapshot({
    generatedAt: '2026-10-04T00:00:00.000Z',
    repo: parseRepo('Keelcodes/keel'),
    values: {},
    npm: {},
    telemetry: { 'settlement.intent': 7, 'conformance.run': 3 },
    docs: { visits: 1200 },
    adopters: [{ name: 'a' }, { name: 'b' }],
  });
  const display = (id) => snapshot.metrics.find((metric) => metric.id === id).display;
  assert.equal(display('settlement.intents'), '7');
  assert.equal(display('conformance.runs'), '3');
  assert.equal(display('docs.visits'), '1.2k');
  assert.equal(display('adopters'), '2');

  // A source that is absent stays TBD — never a fabricated 0.
  const cold = snapshotFixture();
  assert.equal(cold.metrics.find((metric) => metric.id === 'settlement.intents').display, 'TBD');
  assert.equal(cold.metrics.find((metric) => metric.id === 'adopters').display, 'TBD');
});

test('buildSnapshot emits a chain row per configured chain, TBD without state', () => {
  const snapshot = snapshotFixture();
  for (const chain of CHAINS) {
    assert.equal(snapshot.metrics.find((metric) => metric.id === `chain.accounts.${chain.key}`).display, 'TBD');
    assert.equal(snapshot.metrics.find((metric) => metric.id === `chain.userops.${chain.key}`).display, 'TBD');
  }

  const measured = buildSnapshot({
    generatedAt: '2026-10-04T00:00:00.000Z',
    repo: parseRepo('Keelcodes/keel'),
    values: {},
    npm: {},
    chains: [{ id: 1, key: 'eth', name: 'ETH', accounts: ['0xaa', '0xbb'], installs: 4, userops: 8 }],
  });
  assert.equal(measured.metrics.find((metric) => metric.id === 'chain.accounts.eth').display, '2');
  assert.equal(measured.metrics.find((metric) => metric.id === 'chain.userops.eth').display, '8');
  assert.equal(measured.metrics.find((metric) => metric.id === 'chain.session_installs.eth').display, '4');
  assert.equal(measured.metrics.find((metric) => metric.id === 'chain.accounts.base').display, 'TBD');
});

test('renderMarkdown emits the measured, per-package, onchain and pending tables', () => {
  const snapshot = snapshotFixture();
  snapshot.badges = badgeDefinitions(snapshot);
  const markdown = renderMarkdown(snapshot);

  assert.match(markdown, /# Metrics/);
  assert.match(markdown, /repository `Keelcodes\/keel`/);
  assert.match(markdown, /\| GitHub stars \| 12 \|/);
  assert.match(markdown, /`@keelcodes\/migrate` \| TBD/);
  assert.match(markdown, /### Onchain adoption/);
  assert.match(markdown, /\| Keel accounts \(BSC\) \| TBD \|/);
  assert.match(markdown, /badges\/stars\.svg/);
  assert.doesNotMatch(markdown, /undefined/);
});

test('renderBadge produces a self-contained SVG and escapes text', () => {
  const svg = renderBadge({ label: 'stars', value: '1.2k' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /aria-label="stars: 1\.2k"/);
  assert.match(svg, />stars</);
  assert.match(svg, />1\.2k</);

  const escaped = renderBadge({ label: 'a<b>&"', value: 'x' });
  assert.match(escaped, /a&lt;b&gt;&amp;&quot;/);
  assert.doesNotMatch(escaped, /a<b>/);
});

test('badgeDefinitions reads headline values from the snapshot', () => {
  const badges = badgeDefinitions(snapshotFixture({ stars: null }));
  assert.equal(badges.find((badge) => badge.file === 'stars.svg').value, 'TBD');
  assert.equal(badges.find((badge) => badge.file === 'contributors.svg').value, '2');
});
