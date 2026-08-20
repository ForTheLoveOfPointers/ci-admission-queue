'use strict';

/**
 * Pure admission decision for the CI queue.
 *
 * No I/O, no dependencies — this is the heart of the queue and is fully
 * unit-testable. The runner (src/run.js) fetches PRs, calls this, and
 * reconciles the result via the GitHub API.
 *
 * @param {Array<{number:number, labels:string[], createdAt:string, bypass:boolean}>} prs
 *   Open PRs. `bypass` is precomputed by the runner (e.g. the PR changes only
 *   cheap paths); `createdAt` is an ISO-8601 timestamp.
 * @param {object} config
 * @param {number} [config.budget=8]        Max PRs admitted to heavy CI at once.
 * @param {"fifo"|"priority"} [config.strategy="fifo"]
 * @param {string[]} [config.bypassLabels]  Labels that skip the queue (not counted).
 * @param {string[]} [config.excludeLabels] Labels that are never auto-admitted.
 * @param {Object<string,number>} [config.priorityLabels] label -> weight (priority mode).
 * @param {string} [config.admittedLabel="ci:admitted"]
 * @returns {{admit:number[], hold:number[], bypass:number[], excluded:number[], toPromote:number[], toDemote:number[]}}
 */
function computeAdmission(prs, config = {}) {
  const budget = Number.isFinite(config.budget) ? Math.max(0, config.budget) : 8;
  const strategy = config.strategy === 'priority' ? 'priority' : 'fifo';
  const bypassLabels = new Set(config.bypassLabels || []);
  const excludeLabels = new Set(config.excludeLabels || []);
  const priorityLabels = config.priorityLabels || {};
  const admittedLabel = config.admittedLabel || 'ci:admitted';

  const hasAny = (pr, set) => pr.labels.some((l) => set.has(l));

  const bypass = [];
  const excluded = [];
  const eligible = [];

  for (const pr of prs) {
    if (pr.bypass || hasAny(pr, bypassLabels)) {
      bypass.push(pr);
    } else if (hasAny(pr, excludeLabels)) {
      excluded.push(pr);
    } else {
      eligible.push(pr);
    }
  }

  const weightOf = (pr) =>
    pr.labels.reduce((max, l) => Math.max(max, priorityLabels[l] || 0), 0);

  eligible.sort((a, b) => {
    if (strategy === 'priority') {
      const dw = weightOf(b) - weightOf(a); // higher weight first
      if (dw !== 0) return dw;
    }
    const dt = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (dt !== 0) return dt; // oldest first
    return a.number - b.number; // stable, deterministic final tie-break
  });

  const admit = eligible.slice(0, budget);
  const hold = eligible.slice(budget);

  const isAdmitted = (pr) => pr.labels.includes(admittedLabel);
  const toPromote = admit.filter((pr) => !isAdmitted(pr)).map((p) => p.number);
  const toDemote = hold.filter((pr) => isAdmitted(pr)).map((p) => p.number);

  return {
    admit: admit.map((p) => p.number),
    hold: hold.map((p) => p.number),
    bypass: bypass.map((p) => p.number),
    excluded: excluded.map((p) => p.number),
    toPromote,
    toDemote,
  };
}

module.exports = { computeAdmission };
