# CI Admission Queue

Cap how many open pull requests run **heavy CI** at once.

A GitHub Action that admits up to a budget of PRs into your expensive lanes
(integration suites, Docker builds, e2e), holds the rest in a queue, and
promotes held PRs automatically as slots free up. The gate is a single label —
opting a lane in is one `if:` line.

## How it works

1. A **scheduler** workflow runs on PR events and on a timer.
2. It calls a pure [`computeAdmission`](src/admit.js) function: admit up to
   `budget` PRs (oldest-first or by priority label), bypass cheap PRs,
   exclude `wip`, hold the rest.
3. It reconciles two labels: **`ci:admitted`** on admitted PRs,
   **`ci:queued`** on held PRs.
4. Your heavy lanes gate on the label:

   ```yaml
   if: contains(github.event.pull_request.labels.*.name, 'ci:admitted')
   ```

   Adding the label fires the `labeled` event, starting that PR's heavy CI.
   When a PR merges or closes, the next reconcile promotes the next in line.

Reconciles are cheap on rate limits: a bypass verdict is the `base..head` diff
matched against the configured globs, so it is keyed on the head SHA, the base
SHA, and a fingerprint of the globs, then cached across runs via the Actions
cache. A steady-state cron tick makes almost no `files` API calls; a new commit,
a moved base branch, or an edit to `bypassPaths` invalidates the affected
entries. The cache is rebuilt from the currently-open PRs each run, so it never
grows without bound. PRs whose labels already decide their fate (a bypass or
exclude label) skip the files check entirely.

## Install

1. Add the config (`.github/ci-queue.yml`) — see [`examples/ci-queue.yml`](examples/ci-queue.yml):

   ```yaml
   budget: 8
   strategy: fifo
   bypassPaths: ["**/*.md", ".github/**"]
   excludeLabels: [wip]
   ```

2. Add the scheduler workflow — see [`examples/queue-scheduler.yml`](examples/queue-scheduler.yml).

3. Gate each heavy lane on the label — see [`examples/heavy-lane.yml`](examples/heavy-lane.yml).

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

## Token caveat

Labels added by `GITHUB_TOKEN` **do not trigger new workflow runs** (GitHub's
recursion guard). If your heavy lane triggers on `labeled` and must start
immediately on admission, use a **PAT or GitHub App token** with
`pull-requests: write` in the scheduler. If it also triggers on
`synchronize`, the default token works — the next push runs it with the label
already set.

## Development

```bash
npm test
```

## License

MIT — see [LICENSE](LICENSE).
