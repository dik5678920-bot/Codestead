# AI provider onboarding and operations

AI is an optional personalization layer around canonical curriculum and deterministic grading. It cannot publish curriculum, alter hidden tests, grade official evidence, award mastery, or decide appeals.

## Supported providers

Provider keys are optional during onboarding. Learners can add NVIDIA NIM, OpenRouter, Gemini, OpenAI, Anthropic, or DeepSeek keys. A custom OpenAI-compatible provider requires an administrator-configured allowlisted HTTPS host and model policy. Learners provide credentials; the application chooses the model from provider policy or the supported provider default.

### NVIDIA hosted-endpoint decision

Launch 1 is configured for NVIDIA's hosted API Catalog endpoint at `https://integrate.api.nvidia.com/v1`, not for a locally hosted NIM container. The official [API Catalog quickstart](https://docs.api.nvidia.com/nim/re/docs/api-quickstart) describes obtaining a Developer API key from a model page and calling NVIDIA-hosted DGX Cloud endpoints. NVIDIA's current [NIM product FAQ](https://docs.api.nvidia.com/nim/docs/product) describes Developer Program endpoint access as prototyping/development access and distinguishes it from licensed production deployment. Therefore:

- the private pilot may use an individual key only within the key owner's accepted Developer Program and model-specific terms;
- the application must not claim that hosted NIM is an unlimited or generally free production service;
- each selected model requires review of its model page, third-party license, acceptable-use terms, region/data handling, and available quota;
- public or production launch remains blocked until the operator records the applicable NVIDIA/product terms and a live, non-exposed test key passes the provider health and outage drill.

NGC Personal/Service keys for pulling self-hosted NIM containers are a different operational path. NVIDIA documents key scoping, rotation, and the `NVIDIA Public API Endpoints` permission in the [NGC Catalog guide](https://docs.nvidia.com/ngc/latest/ngc-catalog-user-guide.html). Codestead does not self-host NIM on the CPU-only NUC.

## Learner setup

1. Create a provider key in the provider's own console. Give it the least privilege and smallest practical quota.
2. Read and accept the external-AI disclosure plus the provider-specific routing consent.
3. Paste the key only into the credential form, label it, and run the built-in test.
4. Confirm the masked last four characters and enabled state. Add another key if desired; provider policy chooses the vetted model.
5. Revoke and replace a key immediately if it appears in chat, screenshots, logs, source, or another person's device.

## Storage and routing boundary

- Keys are AES-256-GCM envelope-encrypted before database storage. The master key remains outside database backups.
- Plaintext exists only in bounded application memory while making the selected provider request. It is excluded from logs, analytics, tutor context, model-call ledgers, browser storage, exports, email, and runner jobs.
- Provider success/failure metadata is written only through an active-row compare-and-swap bound to credential owner, key version, and `updated_at` snapshot. A learner/admin disable, replacement, or newer validation always wins; a late tutor result never re-enables or overwrites that credential state.
- Tutor calls and administrator credential `test`/`replace` require client UUIDs and durable PostgreSQL receipts scoped to authenticated owner plus action. A canonical input-hash mismatch returns 409; exact/concurrent retries execute one provider call and one mutation/audit/notification set, then replay the original safe JSON response. Replacement plaintext is never stored in a receipt; only the one-way canonical hash and safe result metadata are retained.
- A call requires current external-AI and provider-specific consent. The gateway sends bounded lesson context and learner-selected code/messages, never email, legal identity, credentials, hidden tests, or other learners' data.
- Failed or rate-limited learner keys are attempted in the learner's enabled/preferred order before any administrator-funded destination is considered. Administrator-funded fallback requires separate per-learner and provider consent plus an active model-bound grant.

## Administrator controls

- Configure allowed providers, models, capability order, timeouts, and limits in policy—not from learner input.
- Test/replace/disable/delete credentials without revealing plaintext where possible. Full reveal requires fresh MFA, reason, audit, and learner notice.
- Full reveal is deliberately **not** idempotent or replayable: its strict schema accepts only a reason, and every access must repeat the fresh-MFA, audit, and learner-notification ceremony. Never attach a provider-operation UUID or store a plaintext reveal response.
- A fallback grant must specify learner, credential/provider, exact enabled tutor model, start/end, token cap, rupee cap, and an administrator-approved input/output price snapshot. The pricing snapshot is frozen for local hard-budget accounting; it is not a substitute for reconciling the provider invoice.
- Before transmission, the gateway atomically reserves both the conservative token upper bound and its rupee cost in a durable reservation row. Successful measured usage refunds only the unused portion. Missing or ambiguous provider usage keeps the full reservation charged, and exact reconciliation retries are idempotent. Revocation prevents every new reservation, including concurrent races.
- Review provider terms, data retention, regional processing, model license, safety behavior, and rate limits before production approval. The offline AI evaluation gate verifies application contracts only; it is not evidence of live model quality.

## Failure behavior

When all providers fail or consent is withdrawn, show an explicit degraded state and continue authored lessons, deterministic quizzes, code execution, exams, progress, and appeals. Never silently route to a different provider or an administrator key.

## Validation and preference recovery

Credential validation runs synchronously in the add, Test/Validate, replacement, and Enable actions; there is no background validation worker. A successful probe stores `active` (shown as valid), an authentication rejection stores `invalid`, and all other failures store `unreachable` with a safe reason. Requests have a finite deadline covering the provider request and response body. Incomplete additions and interrupted legacy-pending validations remain retryable without re-entering the key.

For an existing `pending_validation` key, select **Validate** in Settings > AI providers. This decrypts and tests that stored key after the existing server-side fresh-MFA and provider-consent checks. It does not require replacing or re-adding the key. Restoring withdrawn routing consent is still required before provider use.

At most one key per learner is preferred across all providers. Migration `0070_credential_validation_preference` repairs duplicate preferences by keeping the most recently updated preferred key, then breaking ties by creation time and UUID. It preserves encrypted material and legacy validation outcomes. Apply this reviewed migration before deploying the application change.
