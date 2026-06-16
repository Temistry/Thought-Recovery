import { deleteLocalDbNote, listLocalDbNotes, listLocalDbThoughtFlows, moveLocalDbNoteToTrash, readLocalDbValue, replaceLocalDbThoughtFlows, restoreLocalDbTrashNote, upsertLocalDbNotes, upsertLocalDbThoughtDraft, writeLocalDbValue } from './localDb';
import { MergedThoughtDraft, Note, ThoughtFlow } from '../types';

export type LocalDbSmokeTestResult = {
  ok: boolean;
  steps: string[];
};

export async function runLocalDbSmokeTest(): Promise<LocalDbSmokeTestResult> {
  const steps: string[] = [];
  const id = `local-db-smoke-${Date.now()}`;
  const now = new Date().toISOString();
  const fingerprintKey = 'local-db-smoke:thought-flow-fingerprint';
  let previousFlows: ThoughtFlow[] | null = null;
  let previousFingerprint: string | null = null;
  const note: Note = {
    id,
    raw_text: 'SQLite smoke test note',
    source_type: 'text',
    ai_title: 'SQLite smoke test',
    ai_summary: 'Temporary note for local DB smoke test',
    ai_tags: ['test'],
    created_at: now,
    updated_at: now,
    sync_status: 'local_only',
    has_local_detail: true,
    detail_cached_at: now,
    dirty: true,
  };

  try {
    await upsertLocalDbNotes([note]);
    const activeAfterInsert = await listLocalDbNotes();
    if (!activeAfterInsert.some((item) => item.id === id)) throw new Error('insert check failed');
    steps.push('insert:list-active');

    await moveLocalDbNoteToTrash(note);
    const activeAfterTrash = await listLocalDbNotes();
    const trashAfterMove = await listLocalDbNotes({ deleted: true });
    if (activeAfterTrash.some((item) => item.id === id)) throw new Error('trash active exclusion failed');
    if (!trashAfterMove.some((item) => item.id === id)) throw new Error('trash list check failed');
    steps.push('move-trash:list-trash');

    const restored = await restoreLocalDbTrashNote(id);
    if (!restored) throw new Error('restore returned null');
    const activeAfterRestore = await listLocalDbNotes();
    if (!activeAfterRestore.some((item) => item.id === id)) throw new Error('restore active check failed');
    steps.push('restore:list-active');

    await deleteLocalDbNote(id);
    const activeAfterDelete = await listLocalDbNotes();
    const trashAfterDelete = await listLocalDbNotes({ deleted: true });
    if (activeAfterDelete.some((item) => item.id === id) || trashAfterDelete.some((item) => item.id === id)) {
      throw new Error('delete cleanup check failed');
    }
    steps.push('delete:cleanup');

    previousFlows = await listLocalDbThoughtFlows(100);
    previousFingerprint = await readLocalDbValue<string>(fingerprintKey);
    const flow = createSmokeThoughtFlow(id, note, now);
    const draft: MergedThoughtDraft = {
      ...flow.mergedDraft,
      id: `${flow.id}:draft:saved`,
      title: 'SQLite smoke merged draft saved',
      status: 'saved',
      createdAt: new Date(Date.now() + 1).toISOString(),
    };

    await replaceLocalDbThoughtFlows([flow]);
    await upsertLocalDbThoughtDraft(draft);
    await writeLocalDbValue(fingerprintKey, `fingerprint:${id}`);
    const [cachedFlows, savedFingerprint] = await Promise.all([
      listLocalDbThoughtFlows(10),
      readLocalDbValue<string>(fingerprintKey),
    ]);
    const cachedFlow = cachedFlows.find((item) => item.id === flow.id);
    if (!cachedFlow) throw new Error('thought flow cache check failed');
    if (cachedFlow.title !== draft.title || cachedFlow.status !== 'saved') throw new Error('thought flow draft overlay check failed');
    if (savedFingerprint !== `fingerprint:${id}`) throw new Error('thought flow fingerprint kv check failed');
    steps.push('thought-flow-cache:draft:fingerprint');

    await replaceLocalDbThoughtFlows(previousFlows);
    await writeLocalDbValue(fingerprintKey, previousFingerprint);
    steps.push('thought-flow-cache:restore');

    return { ok: true, steps };
  } catch (error) {
    await deleteLocalDbNote(id).catch(() => undefined);
    if (previousFlows) {
      await replaceLocalDbThoughtFlows(previousFlows).catch(() => undefined);
      await writeLocalDbValue(fingerprintKey, previousFingerprint).catch(() => undefined);
    }
    steps.push(`failed:${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, steps };
  }
}

function createSmokeThoughtFlow(id: string, note: Note, now: string): ThoughtFlow {
  const flowId = `${id}:flow`;
  const draft: MergedThoughtDraft = {
    id: `${flowId}:draft`,
    flowId,
    title: 'SQLite smoke merged draft',
    body: 'Temporary merged draft for ThoughtFlow cache smoke test.',
    judgmentSummary: ['SQLite cache row can attach a draft.'],
    sourceNoteIds: [note.id],
    createdAt: now,
    status: 'draft',
  };

  return {
    id: flowId,
    status: 'temporary',
    title: 'SQLite smoke ThoughtFlow',
    noteIds: [note.id],
    notes: [note],
    mergedDraft: draft,
    synthesis: 'SQLite ThoughtFlow smoke synthesis',
    sharedProblem: 'Validate local ThoughtFlow cache tables',
    whyNow: 'Needed before device-side SQLite migration checks',
    nextQuestion: 'Does the cache restore cleanly after the smoke test?',
    createdAt: now,
    updatedAt: now,
    sharedIntent: 'verification',
    sharedDecisionAxis: 'local cache reliability',
    confidenceScore: 1,
  };
}
