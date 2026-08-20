# CI Admission Queue

Cap how many open pull requests run **heavy CI** at once.

A GitHub Action that admits up to a budget of PRs into your expensive lanes
(integration suites, big Docker builds, e2e), holds the rest in a queue, and
promotes held PRs automatically as slots free up. The gate is a single label,
so opting a lane in is one `if:` line and nothing about your review flow changes.

## Why this exists

GitHub-hosted runners scale out, so "too many PRs" rarely starves *runners*.
What it starves are the **shared, capped resources** behind a busy monorepo:

- the **10 GB Actions cache** (branch-scoped, LRU) — under churn, warm build
  caches get evicted, so PR builds recompile from cold and can blow the runner
  disk;
- **self-hosted runner pools**, if you have them;
- **spend** — every open PR re-running an hour-long suite on each push adds up.

GitHub's own **merge queue** governs the *merge* path — it batches PRs about to
land. It does **not** limit how much CI runs while dozens of PRs sit open. This
tool fills that gap: an *admission* queue for open-PR CI, not a merge queue.

## How it works

```
open PRs ──▶ scheduler ──▶ compute admission (budget, fifo/priority, bypass)
                              │
                    ┌─────────┴─────────┐
              add ci:admitted      hold (ci:queued)
                    │                     │
        labeled event fires       heavy lane's `if:` is false
        → heavy lane runs         → skipped, $0
```

1. A **scheduler** workflow runs on a timer and on PR open/close/ready.
2. It calls the pure [`computeAdmission`](src/admit.js) decision: admit up to
   `budget` PRs (oldest-first, or by priority label), bypass cheap PRs
   (docs/CI-only), exclude `wip`, hold the rest.
3. It reconciles two labels: **`ci:admitted`** on the admitted set,
   **`ci:queued`** on the held set.
4. Your heavy lanes gate on the label:
   `if: contains(github.event.pull_request.labels.*.name, 'ci:admitted')`.
   Adding the label fires the `labeled` event, which starts that PR's heavy CI.
   When a PR merges/closes, the next reconcile promotes the next in line.

The admission decision is a **pure, dependency-free function** with a full unit
suite (`npm test`) — the part worth trusting is the part you can test offline.

## Install

1. Add the config (`.github/ci-queue.yml`) — see [`examples/ci-queue.yml`](examples/ci-queue.yml):

   ```yaml
   budget: 8
   strategy: fifo
   bypassPaths: ["**/*.md", ".github/**"]
   excludeLabels: [wip]
   ```

2. Add the scheduler workflow — see [`examples/queue-scheduler.yml`](examples/queue-scheduler.yml).

3. Gate each heavy lane on the label — see [`examples/heavy-lane.yml`](examples/heavy-lane.yml):

   ```yaml
   on:
     pull_request:
       types: [labeled, synchronize, reopened]
   jobs:
     integration:
       if: contains(github.event.pull_request.labels.*.name, 'ci:admitted')
   ```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `budget` | `8` | Max PRs admitted to heavy CI at once. |
| `strategy` | `fifo` | `fifo` (oldest first) or `priority` (by label weight, then oldest). |
| `priorityLabels` | `{}` | `label: weight` map for `priority` mode. |
| `bypassLabels` | `[]` | Labels that skip the queue and don't count against budget. |
| `bypassPaths` | `[]` | PRs whose changed files **all** match a glob are bypassed (cheap). |
| `excludeLabels` | `[]` | Labels that are never auto-admitted. |
| `admittedLabel` | `ci:admitted` | The gate label your lanes check. |
| `queuedLabel` | `ci:queued` | Applied to held PRs for visibility. |

## The token caveat (read this)

Labels added by the built-in `GITHUB_TOKEN` **do not trigger new workflow
runs** — GitHub's recursion guard. So:

- If your heavy lane also triggers on `pull_request: [synchronize]`, the default
  `GITHUB_TOKEN` is fine: the next push runs it, now that the `if:` passes.
- If it should start **immediately on admission** (on `labeled`), give the
  scheduler a **PAT or GitHub App token** with `pull-requests: write` instead.

## Design notes / limits

- **Label gate, not draft.** An earlier design flipped PRs to draft; this manages
  a label instead, so it never touches the author's PR state.
- **One reconcile at a time** via a `concurrency` group — never race two
  schedulers against the label state.
- **Not a merge queue.** Compose with GitHub's merge queue if you want both:
  this throttles pre-merge CI; the merge queue serializes the landing.
- Prototype (`v0.1`): single-repo, label-based, no cross-repo budgets.

## Development

```bash
npm test        # runs the pure-core unit suite (no network, no deps)
```

## License

MIT — see [LICENSE](LICENSE).
