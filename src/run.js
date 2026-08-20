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
const path = require('path');
const core = require('@actions/core');
const github = require('@actions/github');
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

  const prs = [];
  for (const p of openPrs) {
    const labels = p.labels.map((l) => (typeof l === 'string' ? l : l.name));
    const bypass = await isBypassByPaths(octokit, owner, repo, p.number, cfg.bypassPaths);
    prs.push({ number: p.number, labels, createdAt: p.created_at, bypass });
  }

  const decision = computeAdmission(prs, cfg);
  core.info(`admit=${decision.admit.length} hold=${decision.hold.length} ` +
    `bypass=${decision.bypass.length} excluded=${decision.excluded.length}`);

  await reconcile(octokit, owner, repo, decision, cfg);
  writeSummary(decision, cfg);

  core.setOutput('admitted', JSON.stringify(decision.admit));
  core.setOutput('held', JSON.stringify(decision.hold));
}

main().catch((e) => core.setFailed(e.stack || String(e)));
