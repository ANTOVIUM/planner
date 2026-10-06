# Existing Supabase integration

Project: hmdjcxpogdrveddznedx. No new database or account was created. Browser configuration contains only a public publishable key. Authentication uses existing email/password accounts and user session JWTs; passwords are never stored.

Tasks are saved locally first. A durable per-account journal retries changes after connectivity returns. Soft deletion uses the existing archived column. Updates compare the exact server updated_at version. Independent changes merge; conflicting changes retain both task versions. Existing local IDs, notes and settings are preserved. Notes and appearance remain local.

Local priorities normal/medium/high map to database normal/high/critical. Active/done map to planned/done; existing low, waiting and in_progress values are retained for unchanged fields. Deadlines are calendar dates in Europe/Saratov; unchanged server timestamps are preserved.

Verification on 2026-10-06: 80 automated tests passed (36 local storage/core, 12 offline worker, 32 sync/Auth adapter). Live transaction tested 11 owner, foreign-user, anonymous, CAS, archive and trigger checks; all test writes rolled back. Tasks and history remained empty. These role-based database checks do not prove a real email/password browser login; that requires the account holder to sign in. Offline cold-start tests use a network that throws, not browser airplane-mode emulation.

security-hardening.sql is a proposal only, NOT applied. Existing row-level security passed tests. Broader grants/function permission changes require separate approval. Supabase advisor also reports disabled leaked-password protection.

Run: node --test tests/*.test.mjs. After changing runtime files: node scripts/prepare-offline.mjs.
