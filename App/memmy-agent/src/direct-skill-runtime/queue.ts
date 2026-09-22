type PendingDirectSkillMessage = {
  metadata?: Record<string, any> | null;
};

type SynchronousQueue<T> = {
  getNowait(): T | undefined;
  put(item: T): void;
};

/** Remove only undrained Direct Skill messages owned by the completed turn. */
export function discardDirectSkillInjectionsForTask<T extends PendingDirectSkillMessage>(
  queue: SynchronousQueue<T> | null | undefined,
  taskKey: string | null | undefined,
): number {
  if (!queue || !taskKey) return 0;
  const retained: T[] = [];
  let discarded = 0;
  while (true) {
    const item = queue.getNowait();
    if (!item) break;
    const interventionTaskKey = item.metadata?.direct_skill_intervention?.taskKey;
    if (interventionTaskKey === taskKey) discarded += 1;
    else retained.push(item);
  }
  for (const item of retained) queue.put(item);
  return discarded;
}
