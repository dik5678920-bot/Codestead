# Signed-in UI audit

Audited latest `origin/main` at `fe05176` on 2026-10-04, after #134 and #136. Only the P3 onboarding prompt is changed; all P1/P2 findings below are left for assignment.

| File:line | What's fake or unwired | User impact | Severity | Suggested fix |
| --- | --- | --- | --- | --- |
| `src/components/product/settings-view.tsx:461` | Security's **Change password** is permanently disabled and has no action; the card describes a password-change flow but displays “Coming soon.” | Signed-in learners cannot change their password from Settings; the screen directs them to the administrator. This is disclosed unavailable functionality, not a clickable no-op. | P1 user-facing broken | Implement the authenticated password-change flow with verification and the promised session revocation; test the actual mutation and failure recovery. |
| `src/components/product/settings-view.tsx:461` | **View recovery guidance** is permanently disabled with static “Coming soon” text. | Signed-in learners cannot open recovery guidance here and must contact the administrator. Disclosed placeholder. | P1 user-facing broken | Link to accurate recovery instructions and existing `/lost-device` flow, or implement a dedicated guidance panel; verify keyboard navigation and destination. |
| `src/components/lesson/practice-panel.tsx:272` and `:350`; `src/app/(app)/requests/page.tsx:3`; `src/components/product/learning-requests-view.tsx:244` | **Report a content problem** links to `?kind=missing_topic&skillId=…`, but the requests page/component consumes neither parameter. The form defaults to `topic-extension`; the defect kind is `content-defect`. Submission at `learning-requests-view.tsx:191` contains only kind, subject and details. | A learner reporting a specific broken practice/checkpoint lands in an unrelated default request type with no skill context. They must reconstruct the report manually, and can accidentally submit it as an extension. | P2 misleading | Validate/consume query parameters, preselect `content-defect`, and preserve an explicit skill reference through submission; test both practice links end to end. |
| `src/components/shell/app-shell.tsx:405` | Sidebar course search is a static disabled-looking `div` labelled **Search · coming soon**, with no input or search action. | Every signed-in learner sees an unavailable search placeholder. It is clearly disclosed, so this is not an active no-op button. | P2 misleading / incomplete feature | Implement catalog search with real results, or remove the placeholder until available. |
| `src/components/onboarding/onboarding-wizard.tsx:621` | Name prompt uses the fictitious **Aarav Rao** placeholder. The actual default is correctly loaded from the account/profile. | Cosmetic demo identity leaks into real onboarding when the field is empty. | P3 cosmetic — fixed | Replace with **Your name**; regression test renders an account without a display name and verifies an empty value and neutral prompt. |

## Scope and exclusions

- Parsed all 117 non-test TSX files in `src/components/**` and `src/app/(app)/**`. Reviewed native buttons/forms, literal and dynamic links, default values, demo names, numeric/date literals, TODO/mock/placeholder markers, and route-to-component reachability. This is a source audit, not a live authenticated browser walkthrough.
- No native forms without submit handling were found. All 59 literal internal links matched the 168 page/API route patterns; dynamic links and navigation arrays were traced to their corresponding routes. No missing route reachable by real signed-in users was confirmed.
- `LearnerDashboard`'s fixed stats, inert “Choose something else” / “Ask Codestead” buttons, and nonexistent `/review/${review.id}` links are demo-only: `src/app/(app)/learn/page.tsx:12` uses it only when application auth is disabled; real users receive `AuthoritativeDashboard`.
- `AppShell`'s optional default viewer is fictitious, but its only production call site supplies the authenticated session name (`src/app/(app)/layout.tsx:27`); the explicit Aarav viewer at line 36 is demo-only. No real-user leak was confirmed.
- `LessonBlock`'s inert analogy button (`lesson-workspace.tsx:158`), fallback game claiming “Evidence captured” after a length check (`:198`), and fixed visualizer trace (`:129`) are dormant fallback candidates. Every current catalog skill has an authored lesson and assessment bank; the current skill route therefore selects the authored workspace and deterministic game. Do not assign these as active signed-in bugs without a missing-content trigger.
- Settings' hardcoded “Authenticator Enabled” at line 461 follows the current active-account MFA gate; no contradictory reachable signed-in state was established. Security's unavailable actions are listed separately above.
- Playground's fixed five languages, two concurrent jobs and five-second limit agree with runner policy; these are capability labels, not fabricated learner statistics. Authored examples, disclosure versions, ordinary form defaults, empty-state zeros, and clearly labelled curriculum draft/planned previews are not demo learner data.
- #134's Profile panel fetches `/api/settings/profile` and submits PATCH through its form handler; the static mockup is no longer present.

## B.14 — yes, the custom counter is replaced

PR [#123](https://github.com/thebrownhuman/Codestead/pull/123), merged as `4196b7a2ef2085e66846fa0f3f545094eab0769c`, is an ancestor of this audit base. It explicitly replaces the hand-written PostgreSQL upsert while preserving fixed-window behavior.

- `package.json:163` pins `rate-limiter-flexible` 11.2.1.
- `src/lib/security/rate-limit.ts:5` imports `RateLimiterPostgres` / `RateLimiterRes`; `:225` implements `FlexiblePostgresRateLimitStore`, `:242` constructs the library limiter, `:256` calls `limiter.consume`, and `:301` installs that store as the runtime default. No legacy `PostgresRateLimitStore` or `api_rate_limit_window` references remain in non-test `src`.
- `drizzle/0071_rate_limiter_flexible.sql:14` copies existing counts/expiry into the library layout before dropping the old table at line 21. The migration is present in the journal; the integration contract checks the new table and removal of the old one.
- `src/lib/security/__tests__/rate-limit-flexible-parity.test.ts:99` checks all 63 policy defaults, HMAC keys, headers and 429 responses; `:121` checks epoch boundaries and store restart, and `:134` checks fail-closed library persistence errors. These unit tests passed during this audit. Database migration integration tests were inspected, not rerun.

**Nuance:** PostgreSQL storage and epoch fixed windows remain intentionally (`rate-limit.ts:237`); replacing the custom counter does not change to a sliding-window algorithm. If B.14 means removing fixed-window semantics themselves, that part was not changed by #123.

## Validation

- TDD: new empty-account onboarding test failed on `placeholder="Aarav Rao"` before the fix, then passed with `placeholder="Your name"`.
- Onboarding suite plus rate-limit and library parity suites: **103 tests passed** across three files.
- ESLint on both changed TSX files, `tsc --noEmit`, and `git diff --check` passed.
- Failure-only command logs were kept outside the repository. No application logs were added.
- No evidence artifacts, hash pins, dependencies, migrations or P1/P2 implementation files were changed.
