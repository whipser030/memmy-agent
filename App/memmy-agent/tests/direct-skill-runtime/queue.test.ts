import { describe, expect, it } from "vitest";
import { discardDirectSkillInjectionsForTask } from "../../src/direct-skill-runtime/queue.js";

class TestQueue<T> {
  constructor(private readonly items: T[]) {}
  getNowait(): T | undefined { return this.items.shift(); }
  put(item: T): void { this.items.push(item); }
  values(): T[] { return [...this.items]; }
}

describe("discardDirectSkillInjectionsForTask", () => {
  it("drops only stale Direct Skill messages for the completed turn", () => {
    const user = { metadata: { client_request_id: "user-message" } };
    const current = { metadata: { direct_skill_intervention: { taskKey: "turn-1" } } };
    const other = { metadata: { direct_skill_intervention: { taskKey: "turn-2" } } };
    const queue = new TestQueue([user, current, other]);
    expect(discardDirectSkillInjectionsForTask(queue, "turn-1")).toBe(1);
    expect(queue.values()).toEqual([user, other]);
  });
});
