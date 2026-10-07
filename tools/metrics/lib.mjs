// ============================================================================
// Metrics dashboard — pure logic.
//
// The dashboard exists to make Keel's public-good claims verifiable: every
// number shows its source and refresh cadence, and anything not yet wired is
// printed as `TBD` rather than guessed. Nothing here touches the network or the
// filesystem, so the shaping and rendering are testable in isolation
// (`metrics.test.mjs`); `collect.mjs` is the thin I/O shell around it.
//
// See docs/internal/KEEL_PLAN.md §8 (M5) and §9.5, and docs/internal/KEEL_GRANTS.md §6.
// ============================================================================

/** Refresh cadences, mirroring the docs/internal/KEEL_GRANTS.md §6 table. */
export const FREQUENCY = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
};

/**
 * The chains the adoption indexer reads. The hook and EntryPoint live at the
 * same deterministic addresses on all three, so only the deploy block is
 * chain-specific: it is the height of the block whose timestamp is recorded in
 * `contracts/deployments/<id>.json`, i.e. the earliest block that can hold a
 * `SessionInstalled`. `logChunk` is the largest `eth_getLogs` range the default
 * public RPC accepts (Base caps at 500); the RPC itself is overridable per chain
 * via `rpcEnv` so CI can point at a paid endpoint without a code change.
 */
export const CHAINS = [
  {
    id: 56,
    key: 'bsc',
    name: 'BSC',
    hook: '0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F',
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    deployBlock: 126011779,
    logChunk: 2000,
    rpcEnv: 'KEEL_RPC_56',
    defaultRpc: 'https://bsc-rpc.publicnode.com',
  },
  {
    id: 8453,
    key: 'base',
    name: 'Base',
    hook: '0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F',
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    deployBlock: 52239325,
    logChunk: 500,
    rpcEnv: 'KEEL_RPC_8453',
    defaultRpc: 'https://mainnet.base.org',
  },
  {
    id: 1,
    key: 'eth',
    name: 'ETH',
    hook: '0x466b5DC3796D44b0B63FdF2d3bC7a8Ea371a891F',
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    deployBlock: 26131539,
    logChunk: 10000,
    rpcEnv: 'KEEL_RPC_1',
    defaultRpc: 'https://ethereum-rpc.publicnode.com',
  },
];

/**
 * The two on-chain events the adoption counters are derived from:
 *   - `SessionInstalled(address,bytes32,bytes32,uint256,uint256,uint256,uint256)`
 *     on the Keel hook — one per session, `topics[1]` is the indexed account.
 *   - `UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)`
 *     on the canonical EntryPoint — one per UserOp, `topics[2]` is the sender.
 */
export const CHAIN_TOPICS = {
  sessionInstalled: '0x24e2c054e4fc056c7f8f6be1fc22d4636ab738c03d5034217b68d32dd139a46d',
  userOperationEvent: '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f',
};

/** The lowercase address a 32-byte indexed topic encodes, or null. */
export function topicAddress(topic) {
  const value = String(topic ?? '');
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? `0x${value.slice(26).toLowerCase()}` : null;
}

/** A 20-byte address left-padded into an indexed topic. */
export function addressTopic(address) {
  return `0x${String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/** Distinct accounts that installed at least one session, from hook logs. */
export function sessionAccounts(logs) {
  const accounts = new Set();
  for (const log of logs ?? []) {
    const account = topicAddress(log?.topics?.[1]);
    if (account) accounts.add(account);
  }
  return [...accounts].sort();
}

/**
 * Folds one incremental scan into a chain's running state. Counters accumulate
 * from the deploy block, so the dashboard's numbers are "since Keel went live
 * on this chain" rather than a trailing window — the scans are deltas, which is
 * what keeps the daily job's `eth_getLogs` range bounded as the chains grow.
 *
 * @param {{ id: number, key: string, name: string }} chain
 * @param {object | undefined} previous prior state for this chain, if any
 * @param {{ sessionLogs: unknown[], userOpLogs: unknown[], cursorBlock: number }} scan
 */
export function mergeChainScan(chain, previous, scan) {
  const accounts = new Set(previous?.accounts ?? []);
  let installs = previous?.installs ?? 0;
  for (const log of scan.sessionLogs ?? []) {
    const account = topicAddress(log?.topics?.[1]);
    if (account) accounts.add(account);
    installs += 1;
  }
  return {
    id: chain.id,
    key: chain.key,
    name: chain.name,
    cursorBlock: scan.cursorBlock,
    accounts: [...accounts].sort(),
    installs,
    userops: (previous?.userops ?? 0) + (scan.userOpLogs?.length ?? 0),
  };
}

/**
 * Parses `owner/name` (or a GitHub URL) into its parts. Accepts the shapes a
 * caller is likely to paste, and rejects anything it cannot read rather than
 * silently producing a wrong API path.
 *
 * @param {string} input
 * @returns {{ owner: string, name: string, slug: string }}
 */
export function parseRepo(input) {
  const trimmed = String(input ?? '').trim();
  const match = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(trimmed);
  if (!match) throw new Error(`not a GitHub repository: "${input}"`);
  const owner = match[1];
  const name = match[2];
  return { owner, name, slug: `${owner}/${name}` };
}

function asCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Repo-level counters from `GET /repos/:owner/:name`. `open_issues_count` on the
 * repo endpoint includes pull requests — the dashboard reports the split from
 * the search API separately, so this is kept as the combined figure.
 *
 * @param {unknown} json
 */
export function summarizeRepo(json) {
  const repo = json && typeof json === 'object' ? json : {};
  return {
    stars: asCount(repo.stargazers_count),
    forks: asCount(repo.forks_count),
    watchers: asCount(repo.subscribers_count),
    openIssuesAndPrs: asCount(repo.open_issues_count),
  };
}

/**
 * Contributor count. The API is paged, so with `per_page=1` the `Link` header's
 * `rel="last"` page number *is* the count; without a `Link` header (a single
 * page) the array length is the count.
 *
 * @param {string | null | undefined} linkHeader
 * @param {number} pageLength
 * @returns {number}
 */
export function contributorCount(linkHeader, pageLength) {
  const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(String(linkHeader ?? ''));
  if (last) return Number(last[1]);
  return Number.isFinite(pageLength) && pageLength >= 0 ? pageLength : 0;
}

/**
 * A `total_count` from the GitHub search API (`/search/issues`), or null.
 * @param {unknown} json
 */
export function searchTotal(json) {
  if (!json || typeof json !== 'object') return null;
  return asCount(json.total_count);
}

/**
 * Weekly downloads from the npm point API (`/downloads/point/last-week/:pkg`).
 * A package that is not published yet 404s; the caller passes `null` through,
 * which the dashboard prints as `TBD` — never `0`, which would read as a fact.
 *
 * @param {unknown} json
 * @returns {number | null}
 */
export function npmWeeklyDownloads(json) {
  if (!json || typeof json !== 'object') return null;
  return asCount(json.downloads);
}

/** Sums the npm downloads that were actually reported; null when none were. */
export function sumDownloads(byPackage) {
  const values = Object.values(byPackage ?? {}).filter((value) => typeof value === 'number');
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0);
}

/** Compact display for a count: `999`, `1.2k`, `3.4M`, or `TBD` when unknown. */
export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'TBD';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${round1(value / 1000)}k`;
  return `${round1(value / 1_000_000)}M`;
}

function round1(value) {
  return String(Math.round(value * 10) / 10);
}

/**
 * Shapes measured values and the not-yet-wired list into the dashboard model.
 * A metric that has a source but no value yet is kept, with `value: null`, so
 * it renders as `TBD` and its source is still on the record.
 *
 * A chain with no state (the RPC read failed and there is nothing to preserve)
 * still gets its rows — with `value: null` — so a chain dropping out shows as
 * `TBD` rather than silently disappearing from the dashboard.
 *
 * @param {object} input
 * @param {string} input.generatedAt
 * @param {{ owner: string, name: string, slug: string }} input.repo
 * @param {Record<string, number | null>} input.values
 * @param {Record<string, number | null>} input.npm
 * @param {Array<{ id: number, key: string, accounts: string[], installs: number, userops: number }>} [input.chains]
 * @param {Record<string, number> | null} [input.telemetry] counters from the Keel API (`/telemetry`)
 * @param {{ visits?: number } | null} [input.docs] site-analytics figure
 * @param {unknown[] | null} [input.adopters] maintained integrating-projects list
 */
export function buildSnapshot({
  generatedAt,
  repo,
  values,
  npm,
  chains = [],
  telemetry = null,
  docs = null,
  adopters = null,
}) {
  const npmTotal = sumDownloads(npm);
  const counter = (kind) => {
    const value = telemetry?.[kind];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const visits = typeof docs?.visits === 'number' && Number.isFinite(docs.visits) ? docs.visits : null;
  const stateById = new Map(chains.map((chain) => [chain.id, chain]));
  const metrics = [
    { id: 'github.stars', label: 'GitHub stars', value: values.stars, source: 'GitHub API · /repos', frequency: FREQUENCY.daily },
    { id: 'github.forks', label: 'GitHub forks', value: values.forks, source: 'GitHub API · /repos', frequency: FREQUENCY.daily },
    { id: 'github.watchers', label: 'GitHub watchers', value: values.watchers, source: 'GitHub API · /repos', frequency: FREQUENCY.daily },
    { id: 'github.contributors', label: 'Contributors', value: values.contributors, source: 'GitHub API · /contributors', frequency: FREQUENCY.weekly },
    { id: 'github.merged_prs', label: 'Merged pull requests', value: values.mergedPrs, source: 'GitHub API · /search/issues', frequency: FREQUENCY.weekly },
    { id: 'github.open_issues', label: 'Open issues', value: values.openIssues, source: 'GitHub API · /search/issues', frequency: FREQUENCY.weekly },
    { id: 'npm.downloads', label: 'npm weekly downloads', value: npmTotal, source: 'npm registry API', frequency: FREQUENCY.weekly },
    { id: 'docs.visits', label: 'Docs / site visits', value: visits, source: 'site analytics', frequency: FREQUENCY.weekly },
    { id: 'settlement.intents', label: 'Settlement intents', value: counter('settlement.intent'), source: 'Keel API · /telemetry', frequency: FREQUENCY.daily },
    { id: 'conformance.runs', label: 'Conformance suite runs', value: counter('conformance.run'), source: 'Keel API · /telemetry', frequency: FREQUENCY.weekly },
    { id: 'adopters', label: 'Integrating projects', value: adopters === null ? null : adopters.length, source: 'maintained list · metrics/adopters.json', frequency: FREQUENCY.monthly },
    ...CHAINS.flatMap((chain) => {
      const state = stateById.get(chain.id);
      return [
        {
          id: `chain.accounts.${chain.key}`,
          label: `Keel accounts (${chain.name})`,
          value: state ? state.accounts.length : null,
          source: `onchain · KeelPolicyHook SessionInstalled · ${chain.name}`,
          frequency: FREQUENCY.daily,
        },
        {
          id: `chain.userops.${chain.key}`,
          label: `UserOps (${chain.name})`,
          value: state ? state.userops : null,
          source: `onchain · EntryPoint UserOperationEvent · ${chain.name}`,
          frequency: FREQUENCY.daily,
        },
        {
          id: `chain.session_installs.${chain.key}`,
          label: `Session installs (${chain.name})`,
          value: state ? state.installs : null,
          source: `onchain · KeelPolicyHook SessionInstalled · ${chain.name}`,
          frequency: FREQUENCY.daily,
        },
      ];
    }),
  ].map((metric) => ({
    ...metric,
    value: metric.value ?? null,
    display: formatCount(metric.value),
    target: 'TBD',
  }));

  return {
    generatedAt,
    repo: repo.slug,
    metrics,
    packages: Object.entries(npm ?? {})
      .map(([name, downloads]) => ({ name, weeklyDownloads: downloads ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    chains,
    // Everything now has a source, so this is empty and the dashboard's "Not
    // yet wired" section drops out. A source that is unreachable shows as `TBD`
    // in `metrics` — never here, and never as a fabricated `0`.
    pending: [],
  };
}

/** Renders the committed dashboard page (`metrics/README.md`). */
export function renderMarkdown(snapshot) {
  const lines = [
    '# Metrics',
    '',
    '> Auto-generated by [`tools/metrics/collect.mjs`](../tools/metrics/collect.mjs) — do not edit by hand.',
    `> Last updated **${snapshot.generatedAt}** · repository \`${snapshot.repo}\`.`,
    '',
    'Every number is measured from a named source; anything not yet wired is shown as',
    '`TBD` rather than guessed. Targets are filled in per grant application.',
    '',
    '## Measured',
    '',
    '| Metric | Value | Source | Frequency | Target |',
    '|---|---:|---|---|---|',
  ];

  for (const metric of snapshot.metrics.filter((metric) => !metric.id.startsWith('chain.'))) {
    lines.push(`| ${metric.label} | ${metric.display} | ${metric.source} | ${metric.frequency} | ${metric.target} |`);
  }

  if (snapshot.packages.length > 0) {
    lines.push('', '### npm packages', '', '| Package | Weekly downloads |', '|---|---:|');
    for (const pkg of snapshot.packages) {
      lines.push(`| \`${pkg.name}\` | ${formatCount(pkg.weeklyDownloads)} |`);
    }
  }

  lines.push(
    '',
    '### Onchain adoption',
    '',
    'The Keel hook is deployed at the same deterministic address on all three chains.',
    'Counters are cumulative since each deployment, read from `SessionInstalled` (hook)',
    'and `UserOperationEvent` (EntryPoint, filtered to accounts that installed a session).',
    '',
    '| Metric | Value | Source | Frequency | Target |',
    '|---|---:|---|---|---|',
  );
  for (const metric of snapshot.metrics.filter((metric) => metric.id.startsWith('chain.'))) {
    lines.push(`| ${metric.label} | ${metric.display} | ${metric.source} | ${metric.frequency} | ${metric.target} |`);
  }

  if (snapshot.pending.length > 0) {
    lines.push('', '## Not yet wired', '', '| Metric | Source | Frequency |', '|---|---|---|');
    for (const item of snapshot.pending) {
      lines.push(`| ${item.label} | ${item.source} | ${item.frequency} |`);
    }
  }

  lines.push('', '## Badges', '', 'Emitted by the collector and committed to the repo, so no badge service is involved:', '');
  for (const badge of snapshot.badges ?? []) {
    lines.push(`- \`metrics/badges/${badge.file}\` — ![${badge.label}](badges/${badge.file})`);
  }

  lines.push('');
  return lines.join('\n');
}

/** Which badges to emit, given the snapshot's headline numbers. */
export function badgeDefinitions(snapshot) {
  const find = (id) => snapshot.metrics.find((metric) => metric.id === id)?.display ?? 'TBD';
  return [
    { file: 'stars.svg', label: 'stars', value: find('github.stars'), color: '#4c1' },
    { file: 'contributors.svg', label: 'contributors', value: find('github.contributors'), color: '#4c1' },
    { file: 'npm-downloads.svg', label: 'npm / week', value: find('npm.downloads'), color: '#007ec6' },
  ];
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// Text is rendered in an 11px sans font; 7px per glyph is a deliberately
// generous monospace-ish estimate that keeps labels from colliding with the
// right edge. Badges are decorative, so an approximate width is fine.
function textWidth(text) {
  return String(text).length * 7 + 10;
}

/**
 * A self-contained shields-style SVG badge. We emit the SVG ourselves and commit
 * it, so the dashboard needs no badge service (the consumer repo's plan §6.4:
 * avoid a new hosted dependency).
 *
 * @param {{ label: string, value: string, color?: string }} badge
 */
export function renderBadge({ label, value, color = '#4c1' }) {
  const labelText = escapeXml(label);
  const valueText = escapeXml(value);
  const labelWidth = textWidth(label);
  const valueWidth = textWidth(value);
  const width = labelWidth + valueWidth;
  const accessible = `${labelText}: ${valueText}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${accessible}">`,
    `  <title>${accessible}</title>`,
    '  <linearGradient id="s" x2="0" y2="100%">',
    '    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>',
    '    <stop offset="1" stop-opacity=".1"/>',
    '  </linearGradient>',
    '  <clipPath id="r"><rect width="' + width + '" height="20" rx="3" fill="#fff"/></clipPath>',
    '  <g clip-path="url(#r)">',
    `    <rect width="${labelWidth}" height="20" fill="#555"/>`,
    `    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>`,
    `    <rect width="${width}" height="20" fill="url(#s)"/>`,
    '  </g>',
    '  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
    `    <text x="${labelWidth / 2}" y="14">${labelText}</text>`,
    `    <text x="${labelWidth + valueWidth / 2}" y="14">${valueText}</text>`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}
