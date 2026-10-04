# API rate limiting

Codestead uses `rate-limiter-flexible` with PostgreSQL-backed fixed-window counters so enforcement remains consistent across app processes and after a process restart. It does not require Redis. Every identity component of an API counter key is an HMAC-SHA-256 digest over a domain separator, policy scope, identity type, and normalized identity. Raw IP addresses, email addresses, invitation tokens, and user IDs are never written to the API table. Better Auth uses a separate database table with IP-bearing keys, described below.

## Default budgets

| Policy | Default budget | Identity | Protected operation |
|---|---:|---|---|
| `access_request_ip` | 5 / 15 minutes | trusted client IP | Request invite access |
| `access_request_email` | 3 / day | normalized email | Request invite access |
| `invitation_validate_ip` | 30 / 15 minutes | trusted client IP | Validate invitation |
| `invitation_validate_token` | 10 / 15 minutes | invitation token | Validate invitation |
| `invitation_activate_ip` | 10 / hour | trusted client IP | Activate account |
| `invitation_activate_token` | 5 / hour | invitation token | Activate account |
| `fresh_mfa_user` | 10 / 15 minutes | authenticated user | Fresh TOTP assertion |
| `session_revocation_user` | 3 / day | authenticated user | Request device revocation |
| `credential_write_user` | 10 / hour | authenticated user | Add and validate provider key |
| `onboarding_complete_user` | 10 / hour | authenticated user | Complete onboarding |
| `ai_tutor_minute` | 20 / minute | authenticated user | Codestead mentor request |
| `ai_tutor_day` | 500 / day | authenticated user | Codestead mentor request |
| `code_run_minute` | 10 / minute | authenticated user | Playground compile/run |
| `code_run_hour` | 120 / hour | authenticated user | Playground compile/run |
| `exam_start_user` | 5 / hour | authenticated user | Start formal exam |
| `exam_run_user` | 20 / minute | authenticated user | Compile/run during exam |
| `exam_submit_user` | 10 / minute | authenticated user | Submit formal exam |
| `file_upload_user` | 10 / hour | authenticated user | Upload learner file |
| `github_review_user` | 5 / hour | authenticated user | Review public GitHub project |
| `learning_request_user` | 5 / day | authenticated user | Request subject/topic content |

These request budgets complement provider token grants, upload byte quotas, runner concurrency, exam idempotency, and Better Auth's own login protections; they do not replace those controls.

## Enforcement behavior

- The library performs one atomic `INSERT ... ON CONFLICT DO UPDATE` consume operation. Runtime table creation, in-memory blocking, insurance/fallback limiters and unbounded library cleanup are disabled. Concurrent requests cannot exceed a budget through a read/update race.
- Public decisions still saturate at `limit + 1`. The library stores consumed points up to the legacy database cap of 1,000,001. That exact cap CHECK rejection remains a 429; all other persistence errors fail closed with 503.
- Expired rows are deleted opportunistically at most once per five minutes per app process, in batches of 500. Cleanup failure does not invalidate an already successful enforcement decision.
- All current protected operations fail closed. If PostgreSQL or required key configuration is unavailable, the request returns `503 RATE_LIMIT_UNAVAILABLE` and `Retry-After: 30`; expensive/provider/runner work is not started.
- An exhausted budget returns `429 RATE_LIMITED`. Responses include `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-Policy`, `Retry-After`, and compatibility `X-RateLimit-*` fields. Successful responses include the applicable budget headers.
- Multi-window checks are deliberately conservative. If a daily/hourly check blocks after a minute check was consumed, the minute count is not rolled back. This prevents retry amplification.

## Secrets and proxy trust

Set `RATE_LIMIT_HASH_KEY` to an independent random value of at least 32 bytes when practical. If it is empty, the application uses `BETTER_AUTH_SECRET` with explicit domain separation. Neither value belongs in the database, logs, support output, or backups that omit live host secrets.

`RATE_LIMIT_TRUSTED_IP_HEADER` defaults to `cf-connecting-ip`. Only Cloudflare Tunnel may reach the app origin. If direct origin traffic is possible, a caller can forge proxy headers and split its IP budget. Missing or invalid trusted headers enter one shared `unavailable` bucket, which is intentionally restrictive. Never configure a comma-separated forwarding chain; the helper accepts exactly one syntactically valid IPv4 or IPv6 address.

## Overrides

`RATE_LIMIT_OVERRIDES_JSON` may override only known policy names. Limits must be integers from 1 through 1,000,000; windows must be integers from 1 through 31,536,000 seconds; failure mode must be `closed` or `open`. Invalid JSON, unknown names, or unsafe values fail protected requests rather than silently disabling enforcement.

Example:

```env
RATE_LIMIT_OVERRIDES_JSON={"ai_tutor_minute":{"limit":12,"windowSeconds":60},"github_review_user":{"limit":3,"windowSeconds":3600}}
```

Restart app processes after changing policy configuration. Lowering a limit applies immediately to the current fixed window. Do not set high-cost or anonymous policies to `open` without a documented security decision.

## Operations

Monitor rates of HTTP 429 and `RATE_LIMIT_UNAVAILABLE` responses without logging request identities. A sudden cohort-wide 429 for anonymous endpoints can indicate a missing trusted IP header, because all such requests share the `unavailable` bucket. Check the Cloudflare-to-origin header and origin firewall before raising the limit.

The `api_rate_limit` table contains only `key`, `points` and `expire`. Its key encodes the unchanged scope, HMAC identity digest and epoch window start; expiry retains one extra window. It can be included in normal database backup, but it is disposable operational state and does not need restoration. After a restore without counters, budgets simply begin fresh. Do not join hashes to learner data or attempt to reverse identities.

Run the focused safety suite after changing policies or wrappers:

```bash
npm test -- src/lib/security/__tests__/rate-limit.test.ts src/lib/security/__tests__/rate-limit-boundaries.test.ts
```

The suite covers exact boundaries, concurrent calls, window reset, identity/scope isolation, raw-identifier exclusion, fail-open/closed semantics, atomic SQL shape, cleanup failure, header behavior, proxy parsing, override validation, and route wiring.

## Migration 0071

Stop all app processes before applying `0071_rate_limiter_flexible`, then restart on this release. The migration locks the old table, copies every existing count and expiry without granting a fresh budget, and drops `api_rate_limit_window`. The old binary cannot run against the new layout; rollback requires restoring the pre-migration database and deploying the old binary together. Existing role reconciliation and restore authority pins advance to 0071 without widening grants.

## Better Auth database limiter and migration 0072

Production always requires atomic database admission for sign-in, sign-up and TOTP verification, even if `DATABASE_URL` is missing; persistence failures return 503 and never trigger a memory fallback. Development/test processes require the same admission when `DATABASE_URL` is nonblank. Only database-free development/test processes use the native memory budgets so public auth pages can render in the E2E server.

The `atomic-auth-rate-limit` Better Auth request plugin consumes the existing `rate-limiter-flexible` PostgreSQL limiter before endpoint body validation. It enforces sign-in 8/minute, sign-up 3/10 minutes and TOTP verification 6/minute across app instances and restarts, using the API limiter's fixed epoch windows and HMAC identities in `api_rate_limit`. Each endpoint has its own scope; denied attempts increment the atomic counter without gaining admission. These auth policies always fail closed and do not accept API policy overrides. Denials retain Better Auth's exact 429 JSON and `X-Retry-After` header. Better Auth's native limiter remains memory-only as a secondary guard for its base 100/minute and other built-in/plugin rules; the three atomic endpoint rules bypass that secondary limiter in database-backed environments.

Atomic auth IP resolution trusts only `cf-connecting-ip`, independent of API trusted-header overrides. Forwarding headers do not split an auth budget. Missing/invalid Cloudflare addresses share an `unavailable` bucket per endpoint; valid IPv6 addresses are canonicalized. Database-free dev/test uses the native localhost fallback bucket. Keep the Cloudflare Tunnel as the only route to the origin.

Migration 0072 and its reviewed `auth_rate_limit` schema/grants remain intact, although new auth requests no longer write this table. Better Auth's database backend cannot guarantee atomic admission under concurrent requests, so it is no longer an enforcement authority. Historical rows can contain resolved IPs or shared fallback markers and endpoint paths. Do not log or project their keys. Only the app has SELECT/INSERT/UPDATE/DELETE; retention has SELECT/DELETE, and the mail worker has no table access.

Policy `2026-10-04.v6` keeps historical rows inactive for more than one UTC day eligible for the existing daily retention worker, in bounded batches (default 1,000; maximum 5,000). Dry-run reports include aggregate `authRateLimits` counts. Apply deletes recheck `last_request` on the outer DELETE; a row exactly at the cutoff is retained. Review backlog counts and keep the daily worker running. Historical IP-bearing rows can persist in encrypted backups until normal backup expiry. New HMAC auth counters follow the existing API counter cleanup.

Apply `0072_auth_database_rate_limit` with the reviewed owner migration flow and reconcile roles to the approved exact catalog. The migration remains additive and leaves the 0071 API counter untouched. Deploy the app and retention worker together. Moving auth enforcement to HMAC API counters starts fresh endpoint budgets on rollout; subsequent process restarts preserve them. Removal of the unused 0072 table or changes to its approved pins require separate owner review.
