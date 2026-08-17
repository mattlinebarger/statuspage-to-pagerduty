# Spec: Statuspage to PagerDuty Event Orchestration Forwarder

**Repo:** atlassian-statuspages-to-pd-event-orch
**Created:** 2026-08-17

## 1. Problem

Atlassian Statuspage lets subscribers register a webhook URL, but the payload it sends is a fixed Statuspage JSON schema with no way to customize the body or headers. PagerDuty's Events API v2 endpoint (`https://events.pagerduty.com/v2/enqueue`) only accepts PD-CEF formatted JSON with a `routing_key`. There is no native path between the two. The PagerDuty/Statuspage integration works in the opposite direction (PagerDuty incidents publish to your own status page), so today the only way to get a third-party status page into PagerDuty is an email subscription into an email integration, which loses structure and is hard to route.

## 2. Goals

1. A user can deploy this project to Vercel, set one environment variable (their PagerDuty routing key), and subscribe the resulting URL to any Atlassian-hosted status page.
2. Every Statuspage webhook (incident updates, maintenance updates, component updates) is converted to a valid Events API v2 payload and forwarded. Filtering and routing decisions happen in PagerDuty Event Orchestration, not here.
3. Alert lifecycle is managed automatically: a status page incident reaching `resolved` (or a maintenance reaching `completed`) sends `event_action: resolve` with the same `dedup_key`, so the PagerDuty alert auto-resolves.
4. The endpoint responds within Statuspage's 30-second window and returns 2xx on success, so the subscription is not deactivated.
5. Setup is documented well enough that a user who is not the author can go from zero to working in under 15 minutes (README with a Deploy to Vercel button).

## 3. Non-Goals

- **Multi-key routing in this service.** One deployment serves one routing key from an env var. Users watching many status pages point them all at the same deployment and split traffic with Event Orchestration rules. Keeps keys out of URLs and config simple.
- **Filtering or dedup logic beyond lifecycle mapping.** "Forward everything, filter in PD" is the design stance. Adding suppression rules here would duplicate what Event Orchestration already does better.
- **A UI or config dashboard.** Env vars and a README are the whole interface for v1.
- **Non-Atlassian status pages** (Statuspage clones, instatus, etc.). Payload schemas differ. Out of scope until someone needs it.
- **Persistence or queueing.** Vercel functions are stateless. If the PagerDuty enqueue call fails after retries, the event is lost and logged. Acceptable for v1, revisit if it happens in practice.

## 4. Proposed Approach

A single Vercel serverless function (Node runtime, TypeScript, no framework) at `api/webhook.ts`:

1. **Receive** a POST from Statuspage. If `WEBHOOK_SECRET` is set and the request's `?secret=` query param does not match, return 401. If the body does not parse as JSON or contains neither an `incident` nor a `component_update` key, return 400.
2. **Classify** the payload:
   - `incident` present with `type: incident` semantics (statuses `investigating`, `identified`, `monitoring`, `resolved`): incident flow.
   - `incident` present with maintenance statuses (`scheduled`, `in_progress`, `verifying`, `completed`): maintenance flow.
   - `component_update` present: component flow.
3. **Map to PD-CEF:**
   - `routing_key`: from `PAGERDUTY_ROUTING_KEY` env var.
   - `dedup_key`: `statuspage-{incident.id}` for incidents/maintenances, `statuspage-component-{component.id}` for component updates.
   - `event_action`: `resolve` when incident status is `resolved`, maintenance status is `completed`, or component `new_status` is `operational`. Otherwise `trigger`.
   - `severity` from incident `impact`: `critical` to `critical`, `major` to `error`, `minor` to `warning`, `none`/maintenance to `info`. Component updates: `major_outage` to `critical`, `partial_outage` to `error`, `degraded_performance`/`under_maintenance` to `warning`.
   - `summary`: `[{page.status_indicator page name}] {incident name}: {latest update status}` (or component name and status transition for component flow). Truncate to 1024 chars.
   - `source`: the status page's ID/URL from the `page` object.
   - `custom_details`: the raw Statuspage payload (incident updates array, shortlink, timestamps, component data), so Event Orchestration rules can match on any field.
   - `links`: the incident `shortlink` when present.
4. **Forward** to `https://events.pagerduty.com/v2/enqueue`. On network error or 5xx from PagerDuty, retry once. On final failure, return 502 and log the error; on success, return 202.

**Trade-off 1: 502 on forward failure vs. always 200.** Repeated non-2xx responses risk Statuspage deactivating the subscription, but returning 200 on a failed forward silently drops events with no external signal. Choosing 502: a transient PD outage causing a few failed deliveries is visible in Vercel logs and recoverable; silent loss is not. The single retry keeps this rare.

**Trade-off 2: shared-secret query param vs. open endpoint.** Statuspage webhooks are unsigned, so the only auth available is what we embed in the subscription URL. A `?secret=` param leaks into Statuspage's stored subscriber record but blocks drive-by forgery. Worst case on leak is spoofed events on one routing key, and the secret is rotatable. Payload-shape validation alone was rejected because a forged payload is trivially copied from Atlassian's public docs. The secret is optional (enforced only when `WEBHOOK_SECRET` is set) so the zero-config path still works.

## 5. Alternatives Considered

- **PagerDuty Custom Event Transformer (CET).** A JS transform hosted on a PagerDuty service integration accepts arbitrary JSON, no middleware needed. Rejected: legacy feature, bound to a single service rather than Event Orchestration, constrained runtime, and no secret-based auth on the endpoint. It also defeats the stated goal of routing through `events.pagerduty.com/v2/enqueue` with an orchestration key.
- **Email subscription to a PagerDuty email integration.** Works today with zero code. Rejected as the primary path: loses structured fields (impact, status, component), makes lifecycle resolve mapping unreliable, and email parsing rules are brittle. This project exists to replace it.
- **Key-in-URL-path multi-tenancy** (`/api/webhook/{routing_key}`). One deployment could serve many users. Rejected for v1: puts the routing key in URLs and logs, and "deploy your own" is the distribution model anyway.

## 6. Acceptance Criteria

- GIVEN `PAGERDUTY_ROUTING_KEY` is set WHEN a sample Statuspage incident webhook with status `investigating` and impact `critical` is POSTed THEN the function POSTs to `events.pagerduty.com/v2/enqueue` with `event_action: trigger`, `severity: critical`, `dedup_key: statuspage-{incident.id}`, and returns 202.
- GIVEN a prior trigger for incident X WHEN a webhook for incident X with status `resolved` arrives THEN the forwarded event has `event_action: resolve` and the same `dedup_key`.
- WHEN a maintenance webhook with status `completed` arrives THE SYSTEM SHALL send `event_action: resolve`.
- WHEN a component update webhook with `new_status: operational` arrives THE SYSTEM SHALL send `event_action: resolve` with `dedup_key: statuspage-component-{component.id}`.
- GIVEN `WEBHOOK_SECRET=abc` is set WHEN a request arrives without `?secret=abc` THEN the function returns 401 and nothing is sent to PagerDuty.
- GIVEN `WEBHOOK_SECRET` is unset WHEN a valid payload arrives with no secret param THEN it is forwarded normally.
- WHEN the request body is not JSON, or is JSON with neither `incident` nor `component_update` THE SYSTEM SHALL return 400 and send nothing to PagerDuty.
- WHEN the PagerDuty enqueue call fails twice (initial attempt plus one retry) THE SYSTEM SHALL return 502 and log the PagerDuty error body.
- WHEN `PAGERDUTY_ROUTING_KEY` is unset THE SYSTEM SHALL return 500 with a message naming the missing variable, without calling PagerDuty.
- GIVEN a fresh clone WHEN the verification commands in section 8 run THEN all tests pass.

## 7. Scope and Boundaries

**Allowed write paths:**
- `api/` (serverless function and shared mapping module)
- `lib/` (payload classification and PD-CEF mapping, kept pure for testing)
- `test/` (unit tests with fixture payloads from Atlassian docs)
- `package.json`, `tsconfig.json`, `vercel.json`
- `README.md`
- `docs/specs/`

**Read-only context:**
- None identified. The repo is empty at spec time.

**Do not touch:**
- No real PagerDuty routing keys or live endpoints in tests or fixtures. All secrets via env vars, never committed.

If this spec conflicts with an ad-hoc prompt, this spec wins.

## 8. Verification

Commands below are defined by this spec, not confirmed against existing config (the repo is empty). Implementation must wire them up in `package.json`.

```bash
npm install
npm test
```

Then an end-to-end smoke test against a local dev server:

```bash
npx vercel dev &
curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:3000/api/webhook" -H "Content-Type: application/json" -d @test/fixtures/incident-investigating.json
```

Expected: 202 with a mocked or test routing key, 401 when `WEBHOOK_SECRET` is set and the secret param is omitted.

## 9. Open Questions

| Question | Resolved by | Blocks implementation? |
|---|---|---|
| Does Statuspage retry failed webhook deliveries, and after how many failures does it deactivate a subscriber? Atlassian docs do not say. | During implementation, by testing against a real page or Atlassian support | No |
| Should component-flow resolve fire when a component recovers while its parent incident is still open (possible duplicate-resolve noise)? | After v1, based on observed behavior | No |
| Exact `page.status_indicator` values available for the summary line | During implementation, from fixture payloads | No |

## Security and Privacy

- **Data handled:** public status page incident data (incident names, statuses, timestamps, component names). No PII beyond what a status page publishes publicly.
- **Credentials:** `PAGERDUTY_ROUTING_KEY` (a PagerDuty Events API routing key) and optional `WEBHOOK_SECRET`, both supplied as Vercel environment variables. Never logged, never echoed in responses, never committed. `.env` local development follows the same rule via `.gitignore`.
- **What leaves the deployment:** the transformed event to `events.pagerduty.com/v2/enqueue` only. No other outbound calls.
- **Blast radius on failure:** a leaked routing key allows spoofed or resolved events on one PagerDuty service/orchestration. Mitigation: keys are rotatable in PagerDuty, and the optional shared secret blocks unauthenticated spoofing at this endpoint. A compromised deployment cannot read PagerDuty data; routing keys are write-only.

---

> Update this spec in the same commit as the code it describes. A spec that
> no longer matches the code is worse than no spec.
