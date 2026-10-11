/** Preserve standard ACP plan snapshots in an AHP presentation part.
 * This is read-only projection metadata, not a user input or executable action.
 */
export function planPart(update: any) {
  let unavailable = update._meta?.['amplifier.dev/todo']?.unavailable === true;
  let size = 0;
  const entries: {content: string; status: string; priority: string; activeForm?: string}[] = [];
  if (!Array.isArray(update.entries) || update.entries.length > 200) unavailable = true;
  else for (const item of update.entries) {
    const activeForm = item?._meta?.['amplifier.dev/todo']?.activeForm;
    if (!item || typeof item.content !== 'string' || item.content.length > 4000 ||
      !['pending', 'in_progress', 'completed'].includes(item.status) ||
      !['low', 'medium', 'high'].includes(item.priority) ||
      (activeForm !== undefined && (typeof activeForm !== 'string' || activeForm.length > 4000))) {unavailable = true; break;}
    size += item.content.length + (activeForm?.length ?? 0);
    if (size > 16000) {unavailable = true; break;}
    entries.push({content: item.content, status: item.status, priority: item.priority, ...(activeForm ? {activeForm} : {})});
  }
  const plan = unavailable ? {version: 1, unavailable: true, entries: []} : {version: 1, entries};
  return {kind: 'systemNotification', content: unavailable ? 'Plan details unavailable.' : entries.map(e => `${e.status}: ${e.content}`).join('\n'),
    _meta: {'amplifier.dev/acp': {sessionUpdate: 'plan', plan}}};
}
