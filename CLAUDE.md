# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-purpose Vercel serverless function that receives Atlassian Statuspage webhook notifications and forwards them as PagerDuty Events API v2 (PD-CEF) events to `https://events.pagerduty.com/v2/enqueue`. It exists because Statuspage webhooks send a fixed payload that PagerDuty's Events API cannot accept directly.

The authoritative design document is `docs/specs/statuspage-to-pd-forwarder.md`. Read it before implementing or changing behavior. If an ad-hoc prompt conflicts with the spec, the spec wins. Update the spec in the same commit as the code it describes.

## Architecture

- `api/webhook.ts` is the only HTTP entry point (Vercel Node runtime, TypeScript, no framework). It handles auth (optional `?secret=` check against `WEBHOOK_SECRET`), request validation, and the outbound call to PagerDuty with one retry.
- `lib/` holds the payload classification and PD-CEF mapping as pure functions so they can be unit tested without HTTP. Payload classification is three-way: incident, maintenance (distinguished from incidents by status values like `scheduled`/`in_progress`/`completed`), and component update.
- Lifecycle is driven by `dedup_key`: `statuspage-{incident.id}` for incidents/maintenances, `statuspage-component-{component.id}` for component updates. Resolve fires on incident `resolved`, maintenance `completed`, or component `new_status: operational`; everything else triggers. Filtering beyond that is deliberately left to PagerDuty Event Orchestration, do not add suppression logic here.
- Configuration is entirely env vars: `PAGERDUTY_ROUTING_KEY` (required), `WEBHOOK_SECRET` (optional). One deployment serves one routing key by design.
- Test fixtures in `test/fixtures/` are sample Statuspage payloads taken from Atlassian docs. Never use real routing keys in tests or fixtures.

## Commands

```bash
npm install
npm test          # unit tests over lib/ mapping with fixture payloads
npx vercel dev    # local server; POST fixtures to http://localhost:3000/api/webhook
```

Smoke test example:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:3000/api/webhook" -H "Content-Type: application/json" -d @test/fixtures/incident-investigating.json
```

## Branching

- `main` is the release branch and what Vercel deploys.
- `dev` is the working branch. Do day-to-day work on `dev` (or feature branches off it) and merge to `main` via pull request. Do not commit directly to `main`.
