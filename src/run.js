'use strict';

/**
 * CI Admission Queue — runner.
 *
 * Fetches open PRs, decides which are admitted to heavy CI (see src/admit.js),
 * and reconciles the `ci:admitted` / `ci:queued` labels to match. Adding
 * `ci:admitted` fires the target repo's `pull_request: [labeled]` workflows,
 * which is how an admitted PR's heavy lanes start.
 *
 * Runs as a composite action (see action.yml). Reads config from
 * `.github/ci-queue.yml` in the target repo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('@actions/core');
const github = require('@actions/github');
const cache = require('@actions/cache');
const yaml = require('js-yaml');
const { minimatch } = require('minimatch');
const { computeAdmission } = require('./admit');

const DEFAULTS = {
  budget: 8,
  strategy: 'fifo',
  bypassLabels: [],
  excludeLabels: [],
  priorityLabels: {},
  bypassPaths: [],
  admittedLabel: 'ci:admitted',
  queuedLabel: 'ci:queued',
};

function loadConfig(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    core.info(`No config at ${configPath}; using defaults.`);
    return { ...DEFAULTS };
  }
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  return { ...DEFAULTS, ...raw };
}

// A PR bypasses the queue if EVERY changed file matches a bypass glob.
async function isBypassByPaths(octokit, owner, repo, number, bypassPaths) {
  if (!bypassPaths.length) return false;
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner, repo, pull_number: number, per_page: 100,
  });
  if (files.length === 0) return false;
  return files.every((f) =>
    bypassPaths.some((glob) => minimatch(f.filename, glob, { dot: true })));
}

// --- Bypass cache -----------------------------------------------------------
//
// A PR's bypass verdict is a pure function of (its changed-file set, the
// configured bypass globs). The changed-file set is the `base..head` diff, so
// the verdict is stable only while BOTH the head SHA and the base SHA hold and
// the globs are unchanged — advancing the base branch or editing the globs can
// flip it. We therefore key each verdict on all three and can safely reuse it
// across runs, which spares one `listFiles` call per open PR. On a 5-minute
// cron with many PRs that would otherwise burn through the REST rate limit for
// no reason. Verdicts are stored as a JSON map of
// `${number}@${head.sha}@${base.sha}@${globsSig}` -> boolean.
//
// The map is rebuilt from the currently-open PRs on every save, so entries for
// closed PRs, superseded SHAs, and stale globs are pruned rather than
// accumulating forever.
//
// Cache entries are branch-scoped by GitHub; the high-frequency caller (the
// cron scheduler on the default branch) shares one lineage, and PR-triggered
// runs fall back to it via restore keys. Any cache failure degrades to plain
// API lookups.

const BYPASS_CACHE_PREFIX = 'ci-admission-queue-bypass-v1';

// A short, order-independent fingerprint of the bypass globs. Folded into each
// cache key so editing `bypassPaths` invalidates verdicts computed under the
// old config.
function bypassSignature(globs) {
  const norm = [...(globs || [])].sort().join('\n');
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

// The verdict is the `base..head` diff matched against the globs, so all three
// inputs belong in the key (see the note above).
function bypassCacheKey(number, headSha, baseSha, globsSig) {
  return `${number}@${headSha}@${baseSha}@${globsSig}`;
}

function bypassArchivePath() {
  return path.join(process.env.RUNNER_TEMP || os.tmpdir(),
    'ci-admission-queue-bypass.json');
}

async function loadBypassCache() {
  if (!cache.isFeatureAvailable()) return null;
  try {
    const archive = bypassArchivePath();
    const restored = await cache.restoreCache(
      [archive],
      `${BYPASS_CACHE_PREFIX}-${github.context.runId}`,
      [BYPASS_CACHE_PREFIX],
    );
    return restored ? JSON.parse(fs.readFileSync(archive, 'utf8')) : {};
  } catch (e) {
    core.warning(`bypass cache unavailable (${e.message}); using API`);
    return {};
  }
}

async function saveBypassCache(entries) {
  if (!cache.isFeatureAvailable()) return;
  try {
    const archive = bypassArchivePath();
    fs.writeFileSync(archive, JSON.stringify(entries));
    await cache.saveCache([archive], `${BYPASS_CACHE_PREFIX}-${github.context.runId}`);
  } catch (e) {
    // Re-running the same workflow reuses the run id, so "already exists"
    // is normal, not a failure.
    if (String(e.message).includes('already exists')) {
      core.debug('bypass cache already saved for this run');
    } else {
      core.warning(`could not save bypass cache (${e.message})`);
    }
  }
}

/**
 * Attach a `bypass` flag to each open PR, consulting the cross-run cache
 * first. PRs whose labels already decide their fate (a bypass label forces
 * bypass regardless of paths) skip the files API entirely.
 */
async function resolveBypassFlags(octokit, owner, repo, openPrs, cfg) {
  const globs = cfg.bypassPaths || [];
  const bypassLabels = new Set(cfg.bypassLabels || []);
  const cached = await loadBypassCache();
  const globsSig = bypassSignature(globs);
  // Built from the current open PRs only; whatever ends up here is the entire
  // next cache, so stale keys drop out instead of accumulating.
  const next = {};
  let misses = 0;
  let hits = 0;

  const prs = [];
  for (const p of openPrs) {
    const labels = p.labels.map((l) => (typeof l === 'string' ? l : l.name));
    let bypass = false;
    if (globs.length && !labels.some((l) => bypassLabels.has(l))) {
      const key = bypassCacheKey(p.number, p.head.sha, p.base.sha, globsSig);
      if (cached && Object.prototype.hasOwnProperty.call(cached, key)) {
        bypass = Boolean(cached[key]);
        hits += 1;
      } else {
        bypass = await isBypassByPaths(octokit, owner, repo, p.number, globs);
        misses += 1;
      }
      next[key] = bypass;
    }
    prs.push({ number: p.number, labels, createdAt: p.created_at, bypass });
  }

  // Persist when there is new information (a miss) or when pruning changed the
  // key set; if every verdict came straight from an unchanged cache, skip the
  // re-upload entirely.
  if (cached) {
    const pruned = Object.keys(cached).length !== Object.keys(next).length;
    if (misses > 0 || pruned) await saveBypassCache(next);
  }
  core.info(`bypass check: ${misses} API lookup(s), ${hits} served from cache`);
  return prs;
}

async function reconcile(octokit, owner, repo, decision, cfg) {
  const add = (number, labels) =>
    octokit.rest.issues.addLabels({ owner, repo, issue_number: number, labels });
  const remove = (number, label) =>
    octokit.rest.issues
      .removeLabel({ owner, repo, issue_number: number, name: label })
      .catch((e) => { if (e.status !== 404) throw e; }); // 404 = label already absent

  for (const number of decision.toPromote) {
    await add(number, [cfg.admittedLabel]);
    await remove(number, cfg.queuedLabel);
    core.info(`admitted #${number}`);
  }
  for (const number of decision.toDemote) {
    await remove(number, cfg.admittedLabel);
    await add(number, [cfg.queuedLabel]);
    core.info(`demoted #${number} back to queue`);
  }
  // Bypassed/excluded PRs left the queue's world — strip any stale labels.
  for (const number of decision.toClear) {
    await remove(number, cfg.admittedLabel);
    await remove(number, cfg.queuedLabel);
    core.info(`cleared queue labels from #${number}`);
  }
  // Mark still-held PRs as queued so contributors can see their status.
  const promoted = new Set(decision.toPromote);
  for (const number of decision.hold) {
    if (!promoted.has(number)) await add(number, [cfg.queuedLabel]).catch(() => {});
  }
}

function writeSummary(decision, cfg) {
  const line = (nums) => (nums.length ? nums.map((n) => `#${n}`).join(', ') : '—');
  core.summary
    .addHeading('CI Admission Queue', 2)
    .addRaw(`Budget: **${cfg.budget}** · Strategy: **${cfg.strategy}**\n\n`)
    .addTable([
      [{ data: 'State', header: true }, { data: 'PRs', header: true }],
      ['Admitted (running heavy CI)', line(decision.admit)],
      ['Held (queued)', line(decision.hold)],
      ['Bypassed (cheap changes)', line(decision.bypass)],
      ['Excluded (label)', line(decision.excluded)],
    ])
    .write();
}

async function main() {
  const token = core.getInput('token', { required: true });
  const configPath = core.getInput('config') || '.github/ci-queue.yml';
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  // Config lives in the consumer repo's checkout, not the action's dir.
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const cfg = loadConfig(path.resolve(workspace, configPath));
  core.info(`config: budget=${cfg.budget} strategy=${cfg.strategy}`);

  const openPrs = await octokit.paginate(octokit.rest.pulls.list, {
    owner, repo, state: 'open', per_page: 100,
  });

  const prs = await resolveBypassFlags(octokit, owner, repo, openPrs, cfg);

  const decision = computeAdmission(prs, cfg);
  core.info(`admit=${decision.admit.length} hold=${decision.hold.length} ` +
    `bypass=${decision.bypass.length} excluded=${decision.excluded.length}`);

  await reconcile(octokit, owner, repo, decision, cfg);
  writeSummary(decision, cfg);

  core.setOutput('admitted', JSON.stringify(decision.admit));
  core.setOutput('held', JSON.stringify(decision.hold));
}

// Only run when invoked directly (node src/run.js), not when required by a test.
if (require.main === module) {
  main().catch((e) => core.setFailed(e.stack || String(e)));
}

module.exports = { bypassSignature, bypassCacheKey };
