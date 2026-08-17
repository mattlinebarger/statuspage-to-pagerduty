const MAINTENANCE_STATUSES = new Set([
  "scheduled",
  "in_progress",
  "verifying",
  "completed",
]);

const IMPACT_SEVERITY: Record<string, string> = {
  critical: "critical",
  major: "error",
  minor: "warning",
  none: "info",
  maintenance: "info",
};

const COMPONENT_SEVERITY: Record<string, string> = {
  major_outage: "critical",
  partial_outage: "error",
  degraded_performance: "warning",
  under_maintenance: "warning",
  operational: "info",
};

const MAX_SUMMARY_LENGTH = 1024;

export type PayloadKind = "incident" | "maintenance" | "component_update";

export interface PagerDutyEvent {
  routing_key: string;
  event_action: "trigger" | "resolve";
  dedup_key: string;
  payload: {
    summary: string;
    source: string;
    severity: string;
    timestamp?: string;
    custom_details: unknown;
  };
  links?: { href: string; text: string }[];
}

export function classify(body: unknown): PayloadKind | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const payload = body as Record<string, any>;
  if (payload.component_update && payload.component) {
    return "component_update";
  }
  if (payload.incident && typeof payload.incident === "object") {
    return MAINTENANCE_STATUSES.has(payload.incident.status)
      ? "maintenance"
      : "incident";
  }
  return null;
}

function truncate(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH
    ? text.slice(0, MAX_SUMMARY_LENGTH - 3) + "..."
    : text;
}

export function buildEvent(
  body: unknown,
  routingKey: string
): PagerDutyEvent | null {
  const kind = classify(body);
  if (kind === null) {
    return null;
  }
  const payload = body as Record<string, any>;
  const page = payload.page ?? {};
  const source = page.id ? `statuspage:${page.id}` : "statuspage";

  if (kind === "component_update") {
    const update = payload.component_update;
    const component = payload.component;
    const newStatus: string = update.new_status ?? component.status ?? "";
    return {
      routing_key: routingKey,
      event_action: newStatus === "operational" ? "resolve" : "trigger",
      dedup_key: `statuspage-component-${component.id}`,
      payload: {
        summary: truncate(
          `Statuspage component: ${component.name} is ${newStatus} (was ${update.old_status})`
        ),
        source,
        severity: COMPONENT_SEVERITY[newStatus] ?? "warning",
        timestamp: update.created_at,
        custom_details: payload,
      },
    };
  }

  const incident = payload.incident;
  const status: string = incident.status ?? "";
  const resolved =
    kind === "maintenance" ? status === "completed" : status === "resolved";
  const label = kind === "maintenance" ? "maintenance" : "incident";
  const event: PagerDutyEvent = {
    routing_key: routingKey,
    event_action: resolved ? "resolve" : "trigger",
    dedup_key: `statuspage-${incident.id}`,
    payload: {
      summary: truncate(
        `Statuspage ${label}: ${incident.name} (${status})`
      ),
      source,
      severity:
        kind === "maintenance"
          ? "info"
          : IMPACT_SEVERITY[incident.impact] ?? "warning",
      timestamp: incident.updated_at ?? incident.created_at,
      custom_details: payload,
    },
  };
  if (typeof incident.shortlink === "string" && incident.shortlink) {
    event.links = [{ href: incident.shortlink, text: "Status page incident" }];
  }
  return event;
}
