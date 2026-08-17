# Atlassian Statuspage to PagerDuty Event Orchestration

Forward Atlassian Statuspage webhook notifications to PagerDuty as Events API v2 events.

Atlassian Statuspage lets you subscribe to a status page with a webhook, but the payload is a fixed Statuspage format. PagerDuty's Events API (`https://events.pagerduty.com/v2/enqueue`) requires its own JSON schema plus a routing key, so the two cannot talk directly. The only native path is email. This project is the go-between: deploy it to Vercel, subscribe its URL to any Atlassian-hosted status page, and events flow into PagerDuty Event Orchestration.

## What it does

- Converts incident updates, maintenance updates, and component status changes into PagerDuty events.
- Manages alert lifecycle automatically. When the status page incident is resolved (or a maintenance completes, or a component returns to operational), it sends a resolve event with the same `dedup_key`, so the PagerDuty alert closes itself.
- Forwards everything and includes the raw Statuspage payload in `custom_details`, so filtering and routing happen in your Event Orchestration rules, not here.

Severity mapping: incident impact `critical` -> `critical`, `major` -> `error`, `minor` -> `warning`, `none`/maintenance -> `info`. Component status `major_outage` -> `critical`, `partial_outage` -> `error`, `degraded_performance`/`under_maintenance` -> `warning`.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmattlinebarger%2Fatlassian-statuspages-to-pd-event-orch&project-name=statuspage-to-pagerduty&repository-name=statuspage-to-pagerduty&env=PAGERDUTY_ROUTING_KEY,WEBHOOK_SECRET&envDescription=PagerDuty%20Events%20API%20v2%20routing%20key%2C%20and%20a%20random%20string%20used%20as%20the%20webhook%20secret)

The deploy flow suggests `statuspage-to-pagerduty` as the project name, which becomes your `https://statuspage-to-pagerduty-<something>.vercel.app` domain. Change it on the clone screen if you want a different name, or set a custom domain later in the Vercel project settings.

1. In PagerDuty, get an Events API v2 routing key. For Event Orchestration: **Automation > Event Orchestration > your orchestration > Global Orchestration Key**. A service-level Events API v2 integration key also works.
2. Deploy this repo to Vercel with the button above, or fork and import it. Set the environment variable:
   - `PAGERDUTY_ROUTING_KEY` (required): the routing key from step 1.
   - `WEBHOOK_SECRET` (required): any random string, for example from `openssl rand -hex 16`. Requests must include it as a `?secret=` query parameter or they get a 401. Statuspage webhooks are unsigned, so this is the only thing stopping strangers from sending fake events to your PagerDuty service.
3. Subscribe to the status page. On the status page you want to watch, open the **Subscribe** menu, choose the webhook option, and enter your endpoint URL:

   ```
   https://your-app.vercel.app/api/webhook?secret=your-secret-here
   ```

   The status page must have webhook notifications enabled by its owner. If there is no webhook tab in the subscribe menu, the page does not offer webhooks and email is your only option.

4. Trigger or wait for an incident on the watched page and confirm the event arrives in PagerDuty.

One deployment serves one routing key. To watch several status pages, subscribe them all to the same URL and split them in Event Orchestration using `event.custom_details.page.id`.

## Development

```bash
npm install
npm test
npm run typecheck
```

Run locally and smoke test with a fixture:

```bash
npx vercel dev
```

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:3000/api/webhook?secret=your-secret-here" -H "Content-Type: application/json" -d @test/fixtures/incident-investigating.json
```

Expect `202` when both env vars are set (this sends a real event to that routing key), `500` when either is missing, `401` when the secret param is wrong or missing.

Design details live in [docs/specs/statuspage-to-pd-forwarder.md](docs/specs/statuspage-to-pd-forwarder.md).
