# Exams on owner-published courses: plan

Status: plan only. Scope: courses the owner stages and publishes through the curriculum-publication
admin flow (`src/lib/curriculum-publication/*`).

## How exams work today
- **Question banks.** Authored JSON banks per skill (`AssessmentBank`). An item can be used in a
  formal exam only if `isExamEligibleItem(bank, item)`.
  `src/lib/content/authored-schema.ts` (~l.436-452) refuses `examEligibility.eligible = true`
  unless `publication.stage` is `approved` or `published`. That is the **human-approval rule**:
  AI-assisted drafts can never be exam-eligible.
- **Form building.** `src/app/api/exams/_lib/blueprint.ts` `createItem` picks one eligible item per
  skill, seeded and deterministic. If a skill has no eligible item, it falls back to a generated
  prompt with `gradingEvidence.kind = "pending-review"`, so the result becomes `PENDING_REVIEW`.
  Code items need a pinned runner image digest.
- **Start gate.** `service.ts` (~l.575-605): the course must be `beta` or `verified`. For published
  courses, `publishedModuleReadiness` requires independent plus delayed evidence per skill
  (otherwise `EXAM_NOT_READY`).
- **Finalization.** Submit or deadline enqueues `exam_finalization_job`. The worker
  (`src/app/api/exams/_lib/finalization-worker.ts`, run by `scripts/process-exam-finalizations.ts`)
  grades short answers against exact-answer forms and code through the isolated runner. It writes
  `ExamResultOutcome` (`NOT_PASSED` / `PASSED` / `MASTERED` / `PENDING_REVIEW`).
- **Regrade.** `assessment_correction*` + `assessment_regrade_job` / `_outcome`
  (`src/lib/assessment-corrections/worker.ts`) re-score affected attempts. Results go through
  `assessment_attempt_effective_result`.
- **Appeals.** `appeal` / `appeal_event` (`src/lib/appeals/*`), with evidence export.
- **Mastery.** `concept_mastery` / `mastery_evidence`, adjusted by `assessment_mastery_adjustment`
  (+ projection repair). A protected pass enables `exam_mastery_recheck` and `exam_reexam_grant`.

## What's missing for owner-published courses
1. **No path to exam eligibility.** Owner review (`owner-review.ts`) is an audit-log mark only. It
   explicitly does *not* approve content for exams. The one-click "Approve course" flow
   (docs/APP_STATUS.md §8) is still planned: nothing stamps `stage = approved` +
   `reviewer.kind = human` into the banks.
2. As a result, every exam on an owner course is built from `pending-review` fallbacks and ends
   `PENDING_REVIEW`. There is **no admin grading queue** that resolves those outcomes.
3. Beta publication of unreviewed drafts works only with `ALLOW_UNREVIEWED_CURRICULUM=true` (dev).
4. No runner-proof check ties bank items to the course version before they are marked eligible.

## Smallest beta-worthy version: practice quizzes first
Ship **ungraded practice quizzes** on owner-published beta courses before formal exams:
- Draw from *all* bank items (draft items allowed), auto-check exact-answer and runner items, and
  show feedback. Record them as `practice` evidence only, **never** as `mastery_evidence` of exam
  weight and never as an `exam_session`.
- They reuse the existing deterministic selector, exact-answer matcher and runner. There is no
  finalization job, regrade, appeal or certificate impact, so no appeal surface is needed.
- A clear "practice, not certified" label. The human-approval rule stays untouched.

Then **formal exams v1**: implement owner approval per APP_STATUS §8. It stamps banks as
approved/human and marks items eligible only where runner evidence passed, then bumps the course
version and restages. Exams then use eligible items and the existing finalize/regrade/appeal
machinery unchanged. Add an admin queue for any remaining `PENDING_REVIEW`.

## DB migrations and evidence
- **Practice quizzes:** one additive migration (next number after `0069`). This adds a
  `practice_quiz_attempt` table (user, course_version, skill, item hash, outcome, created_at) or
  reuses `practice_help_event` if it fits. Register it in the migration ledger and
  role-boundary tests (`test:migration-ledger`, `test:database-role-boundaries`); grant the
  app role insert/select only.
- **Formal v1:** no schema change is expected for the approval stamp (it lives in the authored JSON
  plus the audit log). The pending-review queue may need a status column or table (a second
  additive migration).
- **Evidence likely affected:** content/structure evidence for re-stamped banks
  (`*-executable-structure-*.json`, `*-executable-runtime-*.json` when `examEligibility` changes),
  `release-quality-gate-2026-07-12.json` pins, and the migration ledger/proof. Every refresh needs
  explicit owner approval.

## Suggested PR slices
1. `feat(practice)`: practice-quiz service + API + migration + role grants + tests.
2. `feat(practice-ui)`: quiz UI on the course/skill page, with "practice" labelling and a11y tests.
3. `feat(curriculum)`: owner "Approve lesson/course" stamping + version bump + restage
   (keeps the schema rule; adds tests that drafts stay ineligible).
4. `feat(exams)`: an admin queue for `PENDING_REVIEW` outcomes (grade → effective result →
   mastery), reusing the correction/regrade paths.
5. `chore(evidence)`: owner-approved evidence refresh for the approved course versions.
