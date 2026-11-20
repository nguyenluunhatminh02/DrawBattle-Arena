# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: apps/web/e2e/scoring-smoke.spec.ts >> API health check + scoring endpoints exist
- Location: apps/web/e2e/scoring-smoke.spec.ts:3:1

# Error details

```
AggregateError: apiRequestContext.get: connect ECONNREFUSED ::1:3001
connect ECONNREFUSED 127.0.0.1:3001
Call log:
  - → GET http://localhost:3001/api/flags
    - user-agent: Playwright/1.65.1 (x64; ubuntu 24.04) node/24.18
    - accept: */*
    - accept-encoding: gzip,deflate,br

```