// ============================================================================
// Metrics dashboard — collector.
//
// Reads GitHub + npm + the three chains, shapes the result through `lib.mjs`,
// and writes the committed dashboard (`metrics/README.md`), the raw snapshot
// (`metrics/snapshot.json`) and the SVG badges. Runs on a schedule from
// `.github/workflows/metrics.yml`.
//
// Three rules, all from docs/internal/KEEL_GRANTS.md §6:
//   1. Never fabricate a number. A source that is down or a package that is not
//      published yet yields `TBD`, not `0`.
//   2. Never clobber a good snapshot with a worse one. If the GitHub repo read
//      fails outright, the previous GitHub/npm figures are carried forward (not
//      replaced with TBDs) and the run exits 1, so a scheduled run refuses to
//      commit a degraded snapshot. A chain RPC that fails keeps that chain's
//      previous counters (or `TBD` on a first run) instead of resetting them.
//   3. The on-chain scan is incremental: each run reads only the blocks since the
//      last cursor and adds to the stored counters, so the daily `eth_getLogs`
//      range stays bounded (and within the public RPCs' range caps) as the
//      chains grow.
//
// Config (all optional):
//   KEEL_GITHUB_REPO   owner/name to track          (default: Keelcodes/keel)
//   GITHUB_TOKEN       raises the GitHub rate limit (default: unauthenticated)
//   KEEL_METRICS_OUT   output directory             (default: metrics)
//   KEEL_RPC_1 / KEEL_RPC_56 / KEEL_RPC_8453        (defaults in lib.mjs CHAINS)
//   KEEL_TELEMETRY_URL base URL of a running @keelcodes/api (its /telemetry
//                      counters drive settlement intents + conformance runs)
//   KEEL_DOCS_STATS_URL endpoint returning {"visits": <number>} from site analytics
//
// The integrating-projects count is read from the committed `metrics/adopters.json`
// (maintained by hand, §6 of docs/internal/KEEL_GRANTS.md), so it needs no network or secret.
// ============================================================================

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  badgeDefinitions,
  buildSnapshot,
  CHAINS,
  CHAIN_TOPICS,
  contributorCount,
  addressTopic,
  mergeChainScan,
  npmWeeklyDownloads,
  parseRepo,
  renderBadge,
  renderMarkdown,
  searchTotal,
  sessionAccounts,
  summarizeRepo,
} from './lib.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT_DIR = path.resolve(ROOT, process.env.KEEL_METRICS_OUT ?? 'metrics');
const REPO = parseRepo(process.env.KEEL_GITHUB_REPO ?? 'Keelcodes/keel');
const TOKEN = process.env.GITHUB_TOKEN;

// Blocks at the tip can still be reorged; stop the scan short of the head so a
// cursor never ends up ahead of a log that later moves.
const CONFIRMATIONS = 12;

const GITHUB_HEADERS = {
  accept: 'application/vnd.github+json',
  'user-agent': 'keel-metrics',
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
};

const EMPTY_VALUES = {
  stars: null,
  forks: null,
  watchers: null,
  contributors: null,
  mergedPrs: null,
  openIssues: null,
};

/** Fetches JSON, returning `{ json: null }` on any HTTP or network failure. */
async function fetchJson(url, headers = {}) {
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error(`  ! ${url} → HTTP ${response.status}`);
      return { json: null, link: null };
    }
    return { json: await response.json(), link: response.headers.get('link') };
  } catch (error) {
    console.error(`  ! ${url} → ${error instanceof Error ? error.message : error}`);
    return { json: null, link: null };
  }
}

/** Published `@keelcodes/*` packages, derived from the workspace manifests. */
async function listPackages() {
  const manifests = [];
  const packagesDir = path.join(ROOT, 'packages');
  try {
    for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) manifests.push(path.join(packagesDir, entry.name, 'package.json'));
    }
  } catch {
    // no packages/ directory — nothing to add
  }
  manifests.push(path.join(ROOT, 'cli', 'package.json'));

  const names = [];
  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.private !== true && typeof manifest.name === 'string' && manifest.name.startsWith('@keelcodes/')) {
        names.push(manifest.name);
      }
    } catch {
      // unreadable / absent manifest — not a package we track
    }
  }
  return [...new Set(names)].sort();
}

async function collectGithub() {
  const repo = await fetchJson(`https://api.github.com/repos/${REPO.slug}`, GITHUB_HEADERS);
  if (repo.json === null) return { ok: false, values: { ...EMPTY_VALUES } };

  const summary = summarizeRepo(repo.json);

  const contributorsResult = await fetchJson(
    `https://api.github.com/repos/${REPO.slug}/contributors?per_page=1&anon=1`,
    GITHUB_HEADERS,
  );
  const contributors =
    contributorsResult.json === null
      ? null
      : contributorCount(
          contributorsResult.link,
          Array.isArray(contributorsResult.json) ? contributorsResult.json.length : 0,
        );

  const search = (query) =>
    fetchJson(`https://api.github.com/search/issues?per_page=1&q=${encodeURIComponent(query)}`, GITHUB_HEADERS);

  const merged = await search(`repo:${REPO.slug} type:pr is:merged`);
  const openIssues = await search(`repo:${REPO.slug} type:issue state:open`);

  return {
    ok: true,
    values: {
      stars: summary.stars,
      forks: summary.forks,
      watchers: summary.watchers,
      contributors,
      mergedPrs: searchTotal(merged.json),
      openIssues: searchTotal(openIssues.json),
    },
  };
}

async function collectNpm(packages) {
  const downloads = {};
  for (const name of packages) {
    const { json } = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${name}`);
    downloads[name] = npmWeeklyDownloads(json);
  }
  return downloads;
}

/**
 * Telemetry counters from a running Keel API (`KEEL_TELEMETRY_URL`). Unset — the
 * dashboard's own deployment, or a plain local build — returns null, which the
 * dashboard prints as `TBD` for those rows rather than `0`.
 */
async function collectTelemetry() {
  const base = process.env.KEEL_TELEMETRY_URL;
  if (!base) return null;
  const { json } = await fetchJson(`${base.replace(/\/$/, '')}/telemetry`);
  const counters = json && typeof json === 'object' ? json.counters : null;
  return counters && typeof counters === 'object' ? counters : null;
}

/** Site-analytics visits (`KEEL_DOCS_STATS_URL`), or null when unset/unreadable. */
async function collectDocs() {
  const url = process.env.KEEL_DOCS_STATS_URL;
  if (!url) return null;
  const { json } = await fetchJson(url);
  return json && typeof json === 'object' && typeof json.visits === 'number' ? json : null;
}

/** The committed integrating-projects list. Null (→ TBD) if it cannot be read. */
async function readAdopters() {
  try {
    const parsed = JSON.parse(await readFile(path.join(ROOT, 'metrics', 'adopters.json'), 'utf8'));
    return Array.isArray(parsed?.adopters) ? parsed.adopters : [];
  } catch {
    return null;
  }
}

/** Reads the previous snapshot so the on-chain cursors and counters survive. */
async function readPreviousSnapshot() {
  try {
    return JSON.parse(await readFile(path.join(OUT_DIR, 'snapshot.json'), 'utf8'));
  } catch {
    return null;
  }
}

const hexBlock = (value) => `0x${BigInt(value).toString(16)}`;

/**
 * A JSON-RPC call with a couple of retries. The default public endpoints reject
 * bursts (and lie about why — publicnode answers a rate limit with "archive
 * requests require a personal token"), so a retry turns a flaky free tier into a
 * slow-but-complete scan.
 */
async function rpcCall(url, method, params, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
      return body.result;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

/** `eth_getLogs` over a range, split into chunks the RPC will accept. */
async function getLogs(url, { address, topics, fromBlock, toBlock, chunk }) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock);
    const page = await rpcCall(url, 'eth_getLogs', [
      { address, topics, fromBlock: hexBlock(start), toBlock: hexBlock(end) },
    ]);
    logs.push(...page);
  }
  return logs;
}

/**
 * Brings each chain's adoption counters up to date. A chain whose RPC fails
 * keeps its previous state — the counters are cumulative, so resetting them
 * would be a lie, and `TBD` (no state) is the honest first-run answer.
 */
async function collectChains(previousChains) {
  const previous = new Map((previousChains ?? []).map((chain) => [chain.id, chain]));
  const results = [];

  for (const chain of CHAINS) {
    const url = process.env[chain.rpcEnv] || chain.defaultRpc;
    const prior = previous.get(chain.id);
    try {
      const head = Number(BigInt(await rpcCall(url, 'eth_blockNumber', []))) - CONFIRMATIONS;
      const from = (prior?.cursorBlock ?? chain.deployBlock - 1) + 1;
      if (from > head) {
        console.error(`  · ${chain.name}: no new blocks (cursor ${prior?.cursorBlock ?? chain.deployBlock - 1}, head ${head})`);
        if (prior) results.push(prior);
        continue;
      }

      const sessionLogs = await getLogs(url, {
        address: chain.hook,
        topics: [CHAIN_TOPICS.sessionInstalled],
        fromBlock: from,
        toBlock: head,
        chunk: chain.logChunk,
      });
      const accounts = new Set([...(prior?.accounts ?? []), ...sessionAccounts(sessionLogs)]);
      const userOpLogs =
        accounts.size === 0
          ? []
          : await getLogs(url, {
              address: chain.entryPoint,
              topics: [CHAIN_TOPICS.userOperationEvent, null, [...accounts].map(addressTopic)],
              fromBlock: from,
              toBlock: head,
              chunk: chain.logChunk,
            });

      const state = mergeChainScan(chain, prior, { sessionLogs, userOpLogs, cursorBlock: head });
      console.error(
        `  · ${chain.name}: blocks ${from}–${head} → +${sessionLogs.length} session installs, +${userOpLogs.length} UserOps`,
      );
      results.push(state);
    } catch (error) {
      console.error(`  ! ${chain.name}: ${error instanceof Error ? error.message : error} — keeping previous onchain values`);
      if (prior) results.push(prior);
    }
  }

  return results;
}

/** Reads the GitHub figures back out of a previous snapshot. */
function carriedForward(snapshot) {
  const value = (id) => snapshot.metrics?.find((metric) => metric.id === id)?.value ?? null;
  return {
    stars: value('github.stars'),
    forks: value('github.forks'),
    watchers: value('github.watchers'),
    contributors: value('github.contributors'),
    mergedPrs: value('github.merged_prs'),
    openIssues: value('github.open_issues'),
  };
}

async function main() {
  const generatedAt = new Date().toISOString();
  console.error(`keel metrics · repo ${REPO.slug} · ${generatedAt}${TOKEN ? '' : ' (unauthenticated)'}`);

  const packages = await listPackages();
  console.error(`  tracking ${packages.length} packages: ${packages.join(', ') || '(none)'}`);

  const previous = await readPreviousSnapshot();

  // npm is independent of GitHub, so it is refreshed either way; only a failed
  // GitHub read has figures worth carrying forward.
  const npm = await collectNpm(packages);
  const github = await collectGithub();
  let { values } = github;
  if (!github.ok) {
    // A private or not-yet-created repo 404s without a token, and the public
    // API rate-limits bursts. Carry the previous GitHub figures forward rather
    // than overwriting real numbers with TBDs — the exit code still signals the
    // failure, so a scheduled run refuses to commit.
    if (previous) {
      console.error('  ! GitHub read failed; carrying the previous GitHub figures forward');
      values = carriedForward(previous);
    } else {
      console.error('  ! GitHub read failed and no snapshot exists; bootstrapping an all-TBD dashboard');
    }
    process.exitCode = 1;
  }

  console.error('  reading onchain adoption…');
  const chains = await collectChains(previous?.chains);

  console.error('  reading telemetry, site analytics and adopters…');
  const [telemetry, docs, adopters] = await Promise.all([
    collectTelemetry(),
    collectDocs(),
    readAdopters(),
  ]);

  const snapshot = buildSnapshot({
    generatedAt,
    repo: REPO,
    values,
    npm,
    chains,
    telemetry,
    docs,
    adopters,
  });
  snapshot.badges = badgeDefinitions(snapshot);

  await mkdir(path.join(OUT_DIR, 'badges'), { recursive: true });
  await writeFile(path.join(OUT_DIR, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, 'README.md'), renderMarkdown(snapshot));
  for (const badge of snapshot.badges) {
    await writeFile(path.join(OUT_DIR, 'badges', badge.file), renderBadge(badge));
  }

  console.error(`  wrote ${path.relative(ROOT, OUT_DIR)}/{snapshot.json, README.md, badges/*.svg}`);
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
