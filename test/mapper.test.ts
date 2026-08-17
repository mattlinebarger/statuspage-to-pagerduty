import { describe, expect, it } from "vitest";
import { buildEvent, classify } from "../lib/mapper.js";
import incidentInvestigating from "./fixtures/incident-investigating.json";
import incidentResolved from "./fixtures/incident-resolved.json";
import maintenanceCompleted from "./fixtures/maintenance-completed.json";
import componentDegraded from "./fixtures/component-degraded.json";
import componentOperational from "./fixtures/component-operational.json";

const ROUTING_KEY = "test-routing-key-not-real";

describe("classify", () => {
  it("identifies incidents", () => {
    expect(classify(incidentInvestigating)).toBe("incident");
  });

  it("identifies maintenances by status", () => {
    expect(classify(maintenanceCompleted)).toBe("maintenance");
  });

  it("identifies component updates", () => {
    expect(classify(componentDegraded)).toBe("component_update");
  });

  it("rejects non-Statuspage bodies", () => {
    expect(classify({ foo: "bar" })).toBeNull();
    expect(classify(null)).toBeNull();
    expect(classify("string")).toBeNull();
    expect(classify([])).toBeNull();
  });
});

describe("buildEvent for incidents", () => {
  it("triggers with critical severity for an investigating critical incident", () => {
    const event = buildEvent(incidentInvestigating, ROUTING_KEY)!;
    expect(event.routing_key).toBe(ROUTING_KEY);
    expect(event.event_action).toBe("trigger");
    expect(event.dedup_key).toBe("statuspage-lbkhbwn21v5q");
    expect(event.payload.severity).toBe("critical");
    expect(event.payload.summary).toContain("Example API is down");
    expect(event.payload.summary).toContain("investigating");
    expect(event.payload.source).toBe("statuspage:j2mfxwj97wnj");
    expect(event.links).toEqual([
      { href: "http://stspg.io/example1", text: "Status page incident" },
    ]);
    expect(event.payload.custom_details).toBe(incidentInvestigating);
  });

  it("resolves with the same dedup_key when the incident is resolved", () => {
    const event = buildEvent(incidentResolved, ROUTING_KEY)!;
    expect(event.event_action).toBe("resolve");
    expect(event.dedup_key).toBe("statuspage-lbkhbwn21v5q");
  });

  it("maps impact levels to severity", () => {
    for (const [impact, severity] of [
      ["critical", "critical"],
      ["major", "error"],
      ["minor", "warning"],
      ["none", "info"],
    ] as const) {
      const payload = structuredClone(incidentInvestigating);
      payload.incident.impact = impact;
      expect(buildEvent(payload, ROUTING_KEY)!.payload.severity).toBe(severity);
    }
  });

  it("truncates summaries longer than 1024 characters", () => {
    const payload = structuredClone(incidentInvestigating);
    payload.incident.name = "x".repeat(2000);
    const summary = buildEvent(payload, ROUTING_KEY)!.payload.summary;
    expect(summary.length).toBeLessThanOrEqual(1024);
  });
});

describe("buildEvent for maintenances", () => {
  it("resolves a completed maintenance with info severity", () => {
    const event = buildEvent(maintenanceCompleted, ROUTING_KEY)!;
    expect(event.event_action).toBe("resolve");
    expect(event.dedup_key).toBe("statuspage-mkhbwn21v5qz");
    expect(event.payload.severity).toBe("info");
  });

  it("triggers an in-progress maintenance", () => {
    const payload = structuredClone(maintenanceCompleted);
    payload.incident.status = "in_progress";
    const event = buildEvent(payload, ROUTING_KEY)!;
    expect(event.event_action).toBe("trigger");
    expect(event.payload.severity).toBe("info");
  });
});

describe("buildEvent for component updates", () => {
  it("triggers with warning severity on degraded_performance", () => {
    const event = buildEvent(componentDegraded, ROUTING_KEY)!;
    expect(event.event_action).toBe("trigger");
    expect(event.dedup_key).toBe("statuspage-component-rb5wq1dczvtm");
    expect(event.payload.severity).toBe("warning");
    expect(event.payload.summary).toContain("Example Widgets API");
  });

  it("resolves with the same dedup_key when the component recovers", () => {
    const event = buildEvent(componentOperational, ROUTING_KEY)!;
    expect(event.event_action).toBe("resolve");
    expect(event.dedup_key).toBe("statuspage-component-rb5wq1dczvtm");
  });

  it("maps component statuses to severity", () => {
    for (const [status, severity] of [
      ["major_outage", "critical"],
      ["partial_outage", "error"],
      ["degraded_performance", "warning"],
      ["under_maintenance", "warning"],
    ] as const) {
      const payload = structuredClone(componentDegraded);
      payload.component_update.new_status = status;
      expect(buildEvent(payload, ROUTING_KEY)!.payload.severity).toBe(severity);
    }
  });
});

describe("buildEvent for invalid input", () => {
  it("returns null for unrecognized bodies", () => {
    expect(buildEvent({ foo: "bar" }, ROUTING_KEY)).toBeNull();
    expect(buildEvent(null, ROUTING_KEY)).toBeNull();
  });
});
