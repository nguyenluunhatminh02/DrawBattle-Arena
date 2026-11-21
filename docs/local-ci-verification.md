# Local CI verification and the GitHub billing limitation

This page records the state of GitHub Actions at commit `f67719e` and gives a
reproducible local procedure for producing CI-equivalent evidence.

## CI status at commit `f67719e` (21 Nov 2026)

Commit `f67719e` ("fix(web): proxy socket.io handshake without trailing-slash
redirect") pushed to `main` triggered [CI run #51](https://github.com/nguyenluunhatminh02/DrawBattle-Arena/actions/runs/44870295188).
The run failed before any workflow step executed:

| Field | Value |
| --- | --- |
| Run | [#51](https://github.com/nguyenluunhatminh02/DrawBattle-Arena/actions/runs/44870295188) |
| Commit | `f67719ece17bf564650b2d6f2c27b59084b675e7` (`f67719e`) |
| Trigger | push to `main` |
| Started / finished | 2026-11-21T05:18:49Z / 05:18:51Z (~2 seconds) |
| Job `build` status | failure, zero steps run, zero billable minutes |
| Cause | GitHub account `nguyenluunhatminh02` is locked for billing; Actions cannot start jobs |

The failure is **not** a TypeScript, Jest, Prisma, Playwright or build failure.
The same pre-lock pattern applies to the earlier failed runs at `d2e7f07` and
`0e93d52`: each stopped in a few seconds with no steps. Changing application
code cannot restore Actions; the billing condition must be resolved on GitHub.

## Fix the billing lock and rerun the workflow

1. Sign in to GitHub as the repository owner (`nguyenluunhatminh02`).
2. Open **Settings → Billing and plans** (https://github.com/settings/billing).
   Resolve the locked state by updating the payment method / paying the
   outstanding balance and confirming the account is no longer locked. A
   confirmation notice and the ability to start Actions jobs indicate success.
3. Check the remaining Actions minutes for the account
   (**Settings → Billing and plans → Plans and usage**). On a private
   repository, included minutes depend on the active plan; this repository is
   public at `f67719e`, but the account-level lock still blocks all jobs.
4. Clear any browser SSO/lock banner, then retry the exact workflow:
   - Open [CI run #51](https://github.com/nguyenluunhatminh02/DrawBattle-Arena/actions/runs/44870295188)
     and choose **Re-run all jobs**, or
   - push a new commit to `main` (the `on: push: branches: [main]` trigger in
     `.github/workflows/ci.yml` starts a fresh run), or
   - run via **Actions → CI → Run workflow** if workflow_dispatch is added later
     (it is not enabled at `f67719e`).
5. Confirm that the `build` job now shows its steps: install, shared build,
   Prisma generate/migrate/seed, typecheck, unit tests, integration tests,
   clean migration check, API/web builds, Playwright + smoke check. A green
   check on the new commit supersedes the local evidence below for that commit.

If the run still fails in ~2 seconds with no steps, the account is still locked;
repeat step 2 rather than debugging the repository code.

## Run the local verification script

`scripts/verify-local-ci.sh` mirrors `.github/workflows/ci.yml` and writes a
plain-text evidence file under `artifacts/` (for example
`artifacts/local-ci-evidence-20261121T060000Z.txt`). The file includes the
commit, tool versions, exact commands, captured output, PASS/FAIL/SKIP per
step, and a final summary. Attach it to a portfolio, issue or PR description
as evidence when Actions is unavailable. It never pushes to GitHub.

### Baseline (works without database or E2E services)

```bash
cd /path/to/DrawBattle
./scripts/verify-local-ci.sh
```

This always runs: install (`--frozen-lockfile`), shared build, Prisma generate,
typecheck, unit tests, API build, web build and `pnpm audit --prod --audit-level=high`.
Database, integration and browser steps are recorded as `SKIP` when their
environment variables are unset. The script exits non-zero if any executed
step fails; an advisory from `pnpm audit` counts as a failure unless
`VERIFY_ALLOW_AUDIT_VULNS=1` is set (the README and
[docs/failure-scenarios.md](./failure-scenarios.md#15-production-dependency-advisories-after-p1-04)
document the known 3-advisory baseline).

### Full CI parity with local services

```bash
cd /path/to/DrawBattle
docker compose up -d postgres redis

DATABASE_URL='postgresql://drawbattle:drawbattle@localhost:5440/drawbattle?schema=public' \
REDIS_URL='redis://localhost:6390' \
JWT_SECRET='ci-test-secret-with-at-least-32-chars' \
E2E_API_URL='http://localhost:3001' \
E2E_WEB_URL='http://localhost:3002' \
./scripts/verify-local-ci.sh
```

`docker-compose.yml` maps PostgreSQL to `:5440` and Redis to `:6390` on this
host; adjust `REDIS_URL` if your Redis is published on `:6379` as in CI. With
all variables set, the script additionally runs migrations, seed, integration
tests, a clean migration check, Playwright browser installation, Playwright
E2E, the post-deploy smoke test, and starts/stops API/Web processes itself.
Set `SKIP_E2E_STARTUP=1` when the services are already running (e.g. an
existing `docker compose up` stack). `PLAYWRIGHT_INSTALL=0` skips browser
download; `PLAYWRIGHT_WITH_DEPS=0` skips OS package installation;
`VERIFY_EVIDENCE_FILE=/path/to/report.txt` chooses the output path;
`VERIFY_SKIP_AUDIT=1` omits the audit step entirely.

### pnpm version caveat (host pnpm 12)

CI uses `pnpm/action-setup@v4` with `version: 9`. Hosts with pnpm 10/11/12 no
longer read the `pnpm.overrides` block in `package.json`, and `pnpm install`
can refuse to run or rewrite the lockfile differently. Use pnpm 9 for exact
parity. A Docker wrapper avoids changing the host install:

```bash
# One-off verification of typecheck + unit tests with the CI pnpm version:
docker run --rm -e CI=true \
  -v "$PWD:/workspace" -w /workspace node:20-slim sh -c \
  'corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm -r typecheck && cd /workspace/apps/api && pnpm exec jest --runInBand'

# Wrap the pnpm 9 command so the full script uses it:
cat >/tmp/pnpm9 <<'SH'
#!/usr/bin/env bash
exec docker run --rm -i -e CI=true -v "$PWD:/workspace" -w /workspace node:20-slim \
  sh -c 'corepack enable >/dev/null && corepack prepare pnpm@9.15.9 --activate >/dev/null && pnpm "$@"' sh "$@"
SH
chmod +x /tmp/pnpm9
VERIFY_PNPM=/tmp/pnpm9 ./scripts/verify-local-ci.sh
```

If Docker creates a root-owned `.pnpm-store` inside the checkout, remove it
with a container (`docker run --rm -v "$PWD:/workspace" -w /workspace alpine:3
rm -rf .pnpm-store`) before staging files; do not use host `sudo rm` on it.
Do not change application code to work around a host pnpm version mismatch.

## What the evidence file proves (and what it does not)

The report shows that the commands in `.github/workflows/ci.yml` pass (or fail)
on the local checkout at the recorded commit. It does **not** satisfy a GitHub
branch-protection requirement or replace a successful run ID. For portfolio or
review purposes, attach the text file plus the commit SHA and note that
Actions was blocked by the account billing lock at the time of writing. Once
billing is fixed and a green Actions run exists, link that run URL as the
authoritative CI result.
