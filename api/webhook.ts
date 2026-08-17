import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildEvent } from "../lib/mapper.js";

const PAGERDUTY_ENQUEUE_URL = "https://events.pagerduty.com/v2/enqueue";

async function sendToPagerDuty(event: unknown): Promise<Response> {
  return fetch(PAGERDUTY_ENQUEUE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    return res
      .status(500)
      .json({ error: "WEBHOOK_SECRET environment variable is not set" });
  }
  if (req.query.secret !== secret) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }

  const routingKey = process.env.PAGERDUTY_ROUTING_KEY;
  if (!routingKey) {
    return res
      .status(500)
      .json({ error: "PAGERDUTY_ROUTING_KEY environment variable is not set" });
  }

  const event = buildEvent(req.body, routingKey);
  if (event === null) {
    return res.status(400).json({
      error:
        "Body is not a Statuspage webhook payload (expected incident or component_update)",
    });
  }

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await sendToPagerDuty(event);
      if (response.ok) {
        return res.status(202).json({ status: "forwarded" });
      }
      lastError = `PagerDuty responded ${response.status}: ${await response.text()}`;
      if (response.status < 500) {
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  console.error(`Failed to forward event to PagerDuty: ${lastError}`);
  return res.status(502).json({ error: "Failed to forward event to PagerDuty" });
}
