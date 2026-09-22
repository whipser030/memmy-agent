import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { normalizeDirectSkillInterventions } from "../../../src/service/turn/turn-normalization.js";
import type { DirectSkillInterventionLog } from "../../../src/types.js";

const { cleanup, createTestService } = createMemoryServiceFixture();

afterEach(cleanup);

const intervention: DirectSkillInterventionLog = {
  taskKey: "turn_direct_skill",
  packageId: "dsp_1",
  eventTypes: ["tool_error", "no_progress"],
  moduleIds: ["module_1", "module_2"],
  injectedAt: "2026-09-22T10:00:00.000Z"
};

describe("Direct Skill intervention logging", () => {
  it("cleans malformed records and preserves a prior valid log as update fallback", () => {
    expect(normalizeDirectSkillInterventions([
      intervention,
      { ...intervention, taskKey: "", moduleIds: [] },
      "invalid"
    ])).toEqual([intervention]);
    expect(normalizeDirectSkillInterventions(undefined, [intervention])).toEqual([intervention]);
    expect(normalizeDirectSkillInterventions([], [intervention])).toEqual([intervention]);
  });

  it("stores injected Package, event, and Module IDs in the Raw Turn completion payload", () => {
    const { db, service } = createTestService();
    const session = service.openSession({
      namespace: {
        source: "memmy-agent",
        profileId: "direct-skill-log",
        userId: "direct-skill-log-user"
      }
    });

    const completed = service.completeTurn("turn_direct_skill", {
      sessionId: session.sessionId,
      query: "Repair the spreadsheet formula.",
      answer: "The formula is repaired and verified.",
      status: "succeeded",
      directSkillInterventions: [intervention]
    });
    const row = db.db.prepare(
      "SELECT message_payload_json FROM raw_turns WHERE id = ?"
    ).get(completed.rawTurnId) as { message_payload_json: string };
    const payload = JSON.parse(row.message_payload_json) as Record<string, any>;

    expect(payload.turn_complete.direct_skill_interventions).toEqual([intervention]);
    db.close();
  });
});
