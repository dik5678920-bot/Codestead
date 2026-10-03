# Local k6 load smoke

This opt-in OSS audit D2 slice exercises real HTTP requests with the self-hosted
[k6 CLI](https://grafana.com/docs/k6/latest/set-up/install-k6/). No Grafana Cloud
account, npm dependency, CI job, or production fixture controller is needed.
Existing load/fault drills remain in place.

**Never run against production without explicit owner OK.** Prefer a disposable
local stack with synthetic users and data. Non-local origins require
`LOAD_OWNER_APPROVED=true` after the owner approves the target, traffic budget,
time window, and cleanup. This flag records your acknowledgment; it cannot
verify permission or detect production behind a local proxy. All HTTP redirects
are disabled, so a login redirect or unexpected host does not silently pass.

## Prepare a local stack

1. Follow the root [local development guide](../README.md#local-development):
   use Node 22.22+, `npm ci`, a fresh local PostgreSQL database, and a local `.env`
   copied from `.env.example`. Replace placeholders, keep `AUTH_REQUIRED=true`,
   set `APP_URL` and `NEXT_PUBLIC_APP_URL` to the same origin as `BASE_URL`, then
   run `npm run db:migrate` and `npm run bootstrap:admin`. Use console mail.
2. For the legacy runner, follow [runner setup](../services/runner/README.md)
   and [runtime image setup](../services/runner/runtime/README.md). Build its
   digest-pinned images, set `RUNNER_BASE_URL=http://127.0.0.1:4100` and matching
   `RUNNER_SHARED_SECRET`, and explicitly set `CODE_RUNNER_PROVIDER=legacy` in
   the **application** environment. Start `npm run runner:local` in another
   terminal. The load script cannot select or prove the app's backend; this
   setting is required to exercise the legacy service rather than Piston.
3. Start the app with `npm run dev`. For useful latency measurements, first
   build and use `npm run build` / `npm start` with your local stack configured
   for that mode; development compilation distorts latency. Warm the pages
   manually before measuring. Keep the local stack's authentication enabled.
4. Through the normal invitation/onboarding flow, create **three different
   synthetic learner accounts**, one each for `login`, `lesson`, and `code_run`.
   Complete password changes, active status, and TOTP enrollment. The runner
   user must accept the current server-execution disclosure and have no active
   closed-book exam. Sign out every browser session for these users before
   testing (one active device is enforced). Do not reuse administrator accounts.
5. Copy `load/accounts.example.json` to `load/accounts.local.json` and replace
   each entry with its disposable user's email/password and base32 TOTP setup
   secret. Keep host clocks synchronized. This ignored file contains secrets;
   never commit it, paste it into logs, or use real learner credentials. Pick
   an accessible lesson and copy a distinctive, visible phrase into
   `LESSON_TEXT`. The default path is
   `/courses/python/skills/string-transformations`; set `LESSON_PATH` if needed.

The script completes email/password + TOTP login and checks the protected
`/learn` page. Lesson and runner accounts authenticate once in setup and their
cookies are installed in their own VUs. The login account signs out after every
iteration; teardown signs out the other two. Interrupted processes can leave
sessions behind: sign those fixture accounts out before retrying. Authentication
setup failures stop the run with a nonzero exit code.

## Run locally

Install k6 on your PATH. From the repository root, in PowerShell:

```powershell
$env:BASE_URL = 'http://localhost:3000'
$env:LESSON_TEXT = '<distinctive phrase visible in your selected lesson>'
npm run test:load:k6
```

Or in Bash:

```bash
BASE_URL=http://localhost:3000 LESSON_TEXT='<phrase from the lesson>' npm run test:load:k6
```

Run only anonymous traffic without preparing accounts or a runner:

```powershell
$env:LOAD_SCENARIOS = 'landing'
npm run test:load:k6
Remove-Item Env:LOAD_SCENARIOS
```

To use Docker instead of installing k6 (Docker Desktop on Windows/macOS):

```powershell
docker run --rm -v "${PWD}/load:/load" -w /load -e BASE_URL=http://host.docker.internal:3000 -e LESSON_TEXT="$env:LESSON_TEXT" grafana/k6:2.3.0 run --no-usage-report smoke.js
```

Use that exact origin in the app's URL configuration for this Docker example;
the app must be reachable from the container. Linux users can run the native
CLI, or use host networking with `BASE_URL=http://localhost:3000`. Run `k6 run`,
never `k6 cloud`, and leave usage reporting disabled as in these commands.

## Scenarios and thresholds

Each selected scenario uses one constant VU for one minute by default.

| Scenario | Operation and success condition | p95 ceiling |
| --- | --- | --- |
| `landing` | Anonymous `GET /`, HTTP 200 with Codestead content | 1,000 ms |
| `login` | Email/password, TOTP, authenticated `GET /learn` | 3,000 ms total |
| `lesson` | Authenticated lesson GET, HTTP 200 with `LESSON_TEXT` | 1,500 ms |
| `code_run` | `POST /api/code/run`, accepted JavaScript result, exit 0, expected stdout, matching fresh UUID, no mastery credit | 15,000 ms |

Every flow must have **error rate <1%**, HTTP errors <1%, and at least one
sample. HTTP 200 with incorrect content/results counts as a flow error.
Redirects, 401/403, missing consent (409), rate limits (429), unavailable runner,
and infrastructure failures are errors. `flow_latency` measures wall time for
the listed operation (including full login/readiness for `login`), excluding
think time, fixture authentication, and logout. The native HTTP metrics also
show individual request timings. These starting thresholds are local smoke
budgets, not a measured capacity claim or a copy of production release gates.

Landing/lesson pause one second; login pauses 31 seconds to avoid reusing a
TOTP step and exceeding auth limits; code runs pause seven seconds to stay
below the default 10/minute account limit. **The 120/hour code-run limit still
applies to repeated/long runs.** Setup also uses the shared-IP auth budget. Use
fresh disposable fixtures or wait for the quota window; do not turn off
authorization or count 429s as successes. Longer runs create more submissions,
runner jobs, auth/audit events, and console mail. Delete the disposable database
and runner state using their normal cleanup procedure when finished.

| Environment variable | Default / purpose |
| --- | --- |
| `BASE_URL` | `http://localhost:3000`; HTTP(S) origin only |
| `LOAD_SCENARIOS` | `landing,login,lesson,code_run`; comma-separated unique subset |
| `LOAD_DURATION` | `1m`; k6 duration for each selected scenario |
| `LOAD_ACCOUNTS_FILE` | `./accounts.local.json`, relative to `load/smoke.js`; absolute paths also work |
| `LESSON_PATH` | `/courses/python/skills/string-transformations` |
| `LESSON_TEXT` | Required for `lesson`; distinctive server-rendered lesson text |
| `LOAD_OWNER_APPROVED` | Unset; `true` only after owner OK for a non-local target |

A one-minute run has few login/runner samples; p95 is only a smoke indicator.
Choose a longer owner-approved duration within quotas for meaningful comparison.
Do not override VUs/executors without provisioning separate accounts and
reviewing quotas, because the authenticated fixtures each share one account.
These HTTP tests do not execute browser JavaScript, fetch all page assets,
grade mastery, or inject faults; retain Playwright and existing recovery drills.

## Results

k6 prints per-flow latency/error thresholds and exits nonzero on failure.
For an optional local JSON summary:

```powershell
New-Item -ItemType Directory -Force load/results | Out-Null
npm run test:load:k6 -- --summary-export=load/results/summary.json
```

`load/results/` is ignored. Do not enable `--http-debug` with credentials or
publish raw auth traffic. Compare results only with the same app build,
hardware, warmup, fixtures, duration, and runner configuration. See
[k6 thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/) and
[scenario metrics](https://grafana.com/docs/k6/latest/using-k6/scenarios/advanced-examples/).
