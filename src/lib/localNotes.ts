import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteLocalDbNote, getLocalDbNoteCount, isLocalDbMigratedFromAsyncStorage, listLocalDbNotes, listLocalDbThoughtDrafts, listLocalDbThoughtFlows, markLocalDbMigratedFromAsyncStorage, moveLocalDbNoteToTrash, readLocalDbThoughtFingerprint, readLocalDbValue, readLocalDbTrashNoteIds, replaceLocalDbActiveNotes, replaceLocalDbThoughtFingerprint, replaceLocalDbThoughtFlows, restoreLocalDbTrashNote, upsertLocalDbNotes, upsertLocalDbThoughtDraft, writeLocalDbValue } from './localDb';
import { buildThoughtFingerprintSnapshot } from './thoughtFingerprint';
import { CloudNoteManifest, LocalSyncMetadata, MergedThoughtDraft, Note, SourceType, ThoughtFingerprintSnapshot, ThoughtFlow } from '../types';

const STORAGE_KEY = 'idea-second-brain:local-notes';
const INDEX_STORAGE_KEY = 'idea-second-brain:local-note-index:v2';
const DETAIL_KEY_PREFIX = 'idea-second-brain:local-note-detail:';
const SYNC_META_KEY = 'idea-second-brain:sync-metadata';
const TRASH_STORAGE_KEY = 'idea-second-brain:local-note-trash:v1';
const DEFAULT_RECENT_LIMIT = 80;

export async function readLocalNoteIndex(): Promise<Note[]> {
  await ensureSqliteStoreReady();
  return sortNotesByFreshness((await listLocalDbNotes()).map(toIndexNote));
}

export async function listRecentLocalNotes(limit = DEFAULT_RECENT_LIMIT): Promise<Note[]> {
  await ensureSqliteStoreReady();
  return sortNotesByFreshness((await listLocalDbNotes({ limit })).map(normalizeLocalNote));
}

export async function listTodayLocalNotes(limit = 24): Promise<Note[]> {
  await ensureSqliteStoreReady();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return sortNotesByFreshness((await listLocalDbNotes({ fromCreatedAt: start.toISOString(), limit })).map(normalizeLocalNote));
}

export async function searchLocalNotes(query: string, limit = 80): Promise<Note[]> {
  await ensureSqliteStoreReady();
  return sortNotesByFreshness((await listLocalDbNotes({ search: query, limit })).map(normalizeLocalNote));
}

export async function readLocalKeyValue<T>(key: string): Promise<T | null> {
  await ensureSqliteStoreReady();
  return readLocalDbValue<T>(key);
}

export async function writeLocalKeyValue<T>(key: string, value: T): Promise<void> {
  await ensureSqliteStoreReady();
  await writeLocalDbValue(key, value);
}

export async function listCachedThoughtFlows(limit = 20): Promise<ThoughtFlow[]> {
  await ensureSqliteStoreReady();
  return listLocalDbThoughtFlows(limit);
}

export async function replaceCachedThoughtFlows(flows: ThoughtFlow[]): Promise<void> {
  await ensureSqliteStoreReady();
  await replaceLocalDbThoughtFlows(flows);
}

export async function saveCachedThoughtDraft(draft: MergedThoughtDraft): Promise<void> {
  await ensureSqliteStoreReady();
  await upsertLocalDbThoughtDraft(draft);
}

export async function listCachedThoughtDrafts(): Promise<Record<string, MergedThoughtDraft>> {
  await ensureSqliteStoreReady();
  return listLocalDbThoughtDrafts();
}

export async function rebuildCachedThoughtFingerprint(notes?: Note[]): Promise<ThoughtFingerprintSnapshot> {
  await ensureSqliteStoreReady();
  const sourceNotes = notes ?? await listLocalDbNotes();
  const snapshot = buildThoughtFingerprintSnapshot(sourceNotes.map(normalizeLocalNote));
  await replaceLocalDbThoughtFingerprint(snapshot);
  return snapshot;
}

export async function readCachedThoughtFingerprint(): Promise<ThoughtFingerprintSnapshot | null> {
  await ensureSqliteStoreReady();
  return readLocalDbThoughtFingerprint();
}

export async function listLocalNotes(): Promise<Note[]> {
  await ensureSqliteStoreReady();
  return sortNotesByFreshness((await listLocalDbNotes()).map(normalizeLocalNote));
}

export async function replaceLocalNotes(notes: Note[]): Promise<void> {
  await ensureSqliteStoreReady();
  await replaceLocalDbActiveNotes(notes.map(normalizeLocalNote));
}

export async function listLocalTrashNotes(): Promise<Note[]> {
  await ensureSqliteStoreReady();
  return sortNotesByFreshness((await listLocalDbNotes({ deleted: true })).map(normalizeLocalNote));
}

export async function moveLocalNoteToTrash(noteToTrash: Note): Promise<Note> {
  await ensureSqliteStoreReady();
  return normalizeLocalNote(await moveLocalDbNoteToTrash(normalizeLocalNote(noteToTrash)));
}

export async function restoreLocalTrashNote(noteId: string): Promise<Note | null> {
  await ensureSqliteStoreReady();
  const restored = await restoreLocalDbTrashNote(noteId);
  return restored ? normalizeLocalNote(restored) : null;
}

export async function deleteLocalTrashNote(noteId: string): Promise<void> {
  await ensureSqliteStoreReady();
  await deleteLocalDbNote(noteId);
}

export async function readLocalTrashNoteIds(): Promise<Set<string>> {
  await ensureSqliteStoreReady();
  return readLocalDbTrashNoteIds();
}

export async function readLocalSyncMetadata(): Promise<LocalSyncMetadata> {
  const raw = await AsyncStorage.getItem(SYNC_META_KEY);
  if (!raw) return {};
  try {
    return normalizeLocalSyncMetadata(JSON.parse(raw) as LocalSyncMetadata);
  } catch {
    return {};
  }
}

export async function writeLocalSyncMetadata(patch: Partial<LocalSyncMetadata>): Promise<LocalSyncMetadata> {
  const current = await readLocalSyncMetadata();
  const next = normalizeLocalSyncMetadata({
    ...current,
    ...patch,
    tabSyncCheckedAt: {
      ...(current.tabSyncCheckedAt ?? {}),
      ...(patch.tabSyncCheckedAt ?? {}),
    },
  });
  await AsyncStorage.setItem(SYNC_META_KEY, JSON.stringify(next));
  return next;
}

export async function createLocalNote(rawText: string, sourceType: SourceType, audioUrl?: string | null, options: { audioDurationMs?: number | null } = {}) {
  const now = new Date().toISOString();
  const note: Note = {
    id: `local-${Date.now()}`,
    raw_text: rawText,
    source_type: sourceType,
    audio_url: audioUrl ?? null,
    local_audio_url: sourceType === 'voice' ? audioUrl ?? null : null,
    audio_duration_ms: options.audioDurationMs ?? null,
    ai_title: makeLocalTitle(rawText),
    ai_summary: rawText.length > 90 ? `${rawText.slice(0, 90)}...` : rawText,
    ai_tags: [],
    created_at: now,
    updated_at: now,
    content_hash: computeNoteHash({ raw_text: rawText, ai_title: makeLocalTitle(rawText), ai_summary: rawText.length > 90 ? `${rawText.slice(0, 90)}...` : rawText }),
    sync_status: 'local_only',
    has_local_detail: true,
    detail_cached_at: now,
    dirty: true,
  };
  await ensureSqliteStoreReady();
  await upsertLocalDbNotes([note]);
  return note;
}


export async function updateLocalNote(
  noteId: string,
  patch: Partial<Pick<Note, 'raw_text' | 'ai_title' | 'ai_summary' | 'ai_tags' | 'audio_url' | 'local_audio_url' | 'audio_duration_ms'>>,
): Promise<Note | null> {
  await ensureSqliteStoreReady();
  const notes = await listLocalDbNotes();
  const current = notes.find((note) => note.id === noteId);
  if (!current) return null;
  const updatedNote = normalizeLocalNote({
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
    sync_status: 'dirty',
    dirty: true,
    has_local_detail: true,
    detail_cached_at: new Date().toISOString(),
  });
  await upsertLocalDbNotes([updatedNote]);
  return updatedNote;
}

export function buildLocalIndexNote(manifest: CloudNoteManifest): Note {
  return normalizeLocalNote({
    ...manifest,
    raw_text: '',
    remote_updated_at: manifest.updated_at ?? manifest.created_at,
    sync_status: 'cloud_only',
    has_local_detail: false,
    dirty: false,
  });
}

function isLocalAudioReference(value?: string | null) {
  return !!value && (value.startsWith('file://') || value.startsWith('content://'));
}

export function normalizeLocalNote(note: Note): Note {
  const rawText = note.raw_text ?? '';
  const hasDetail = note.has_local_detail ?? rawText.trim().length > 0;
  const normalized: Note = {
    ...note,
    raw_text: rawText,
    updated_at: note.updated_at ?? note.created_at,
    has_local_detail: hasDetail,
    detail_cached_at: hasDetail ? note.detail_cached_at ?? note.updated_at ?? note.created_at : note.detail_cached_at ?? null,
    local_audio_url: note.local_audio_url ?? (isLocalAudioReference(note.audio_url) ? note.audio_url ?? null : null),
    audio_duration_ms: typeof note.audio_duration_ms === 'number' && Number.isFinite(note.audio_duration_ms) ? note.audio_duration_ms : null,
    remote_updated_at: note.remote_updated_at ?? (note.user_id || !note.id.startsWith('local-') ? note.updated_at ?? note.created_at : null),
    content_hash: note.content_hash ?? (hasDetail ? computeNoteHash({ ...note, raw_text: rawText }) : null),
    sync_status: note.sync_status ?? (note.user_id || !note.id.startsWith('local-') ? 'synced' : 'local_only'),
    dirty: note.dirty ?? false,
  };
  return normalized;
}

function normalizeLocalSyncMetadata(meta: LocalSyncMetadata): LocalSyncMetadata {
  return {
    lastManifestSyncAt: meta.lastManifestSyncAt ?? null,
    lastKnownRemoteCount: typeof meta.lastKnownRemoteCount === 'number' ? meta.lastKnownRemoteCount : null,
    tabSyncCheckedAt: meta.tabSyncCheckedAt ?? {},
  };
}

export function computeNoteHash(note: Pick<Note, 'raw_text'> & Partial<Pick<Note, 'ai_title' | 'ai_summary' | 'ai_tags' | 'audio_url'>>) {
  const base = [
    note.raw_text ?? '',
    note.ai_title ?? '',
    note.ai_summary ?? '',
    Array.isArray(note.ai_tags) ? note.ai_tags.join(',') : '',
    note.audio_url ?? '',
  ].join('\u001f');
  let hash = 5381;
  for (let index = 0; index < base.length; index += 1) {
    hash = ((hash << 5) + hash) ^ base.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export async function deleteLocalNote(noteId: string): Promise<void> {
  await ensureSqliteStoreReady();
  await deleteLocalDbNote(noteId);
}

let sqliteStoreReadyPromise: Promise<void> | null = null;

async function ensureSqliteStoreReady(): Promise<void> {
  if (!sqliteStoreReadyPromise) {
    sqliteStoreReadyPromise = migrateAsyncStorageToSqliteIfNeeded();
  }
  return sqliteStoreReadyPromise;
}

async function migrateAsyncStorageToSqliteIfNeeded(): Promise<void> {
  const migrated = await isLocalDbMigratedFromAsyncStorage();
  if (migrated) return;

  const existingCount = await getLocalDbNoteCount();
  if (existingCount > 0) {
    await markLocalDbMigratedFromAsyncStorage();
    return;
  }

  const activeNotes = sortNotesByFreshness((await readLegacyActiveNotes()).map((note) => normalizeLocalNote({ ...note, deleted_at: null })));
  const trashNotes = sortNotesByFreshness((await readLegacyTrashNotes()).map((note) => normalizeLocalNote(note)));
  if (activeNotes.length) await replaceLocalDbActiveNotes(activeNotes);
  if (trashNotes.length) await upsertLocalDbNotes(trashNotes);
  await markLocalDbMigratedFromAsyncStorage();
}

async function readLegacyActiveNotes(): Promise<Note[]> {
  const index = await readStoredIndex();
  return hydrateIndexedNotes(index);
}

async function readStoredIndex(): Promise<Note[]> {
  const rawIndex = await AsyncStorage.getItem(INDEX_STORAGE_KEY);
  if (rawIndex) {
    try {
      const parsed = JSON.parse(rawIndex) as Note[];
      return parsed.map(normalizeLocalNote);
    } catch {
      return [];
    }
  }

  const legacyNotes = await readLegacyNotes();
  if (legacyNotes.length) {
    await writeNotesToSplitStore(legacyNotes);
  }
  return legacyNotes.map(toIndexNote);
}

async function readLegacyNotes(): Promise<Note[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as Note[]).map(normalizeLocalNote);
  } catch {
    return [];
  }
}

async function hydrateIndexedNotes(indexNotes: Note[]): Promise<Note[]> {
  if (!indexNotes.length) return [];
  const detailKeys = indexNotes.filter((note) => note.has_local_detail).map((note) => detailStorageKey(note.id));
  const detailEntries = detailKeys.length ? await AsyncStorage.multiGet(detailKeys) : [];
  const detailById = new Map<string, Note>();

  for (const [key, raw] of detailEntries) {
    if (!raw) continue;
    try {
      const id = key.slice(DETAIL_KEY_PREFIX.length);
      detailById.set(id, normalizeLocalNote(JSON.parse(raw) as Note));
    } catch {
      // Ignore one corrupt detail record instead of losing the whole note list.
    }
  }

  return indexNotes.map((indexNote) => {
    const detail = detailById.get(indexNote.id);
    if (!detail) return normalizeLocalNote(indexNote);
    return normalizeLocalNote({
      ...indexNote,
      ...detail,
      // Keep fresher cloud index metadata while preserving cached detail text.
      ai_title: indexNote.ai_title ?? detail.ai_title,
      ai_summary: indexNote.ai_summary ?? detail.ai_summary,
      ai_tags: indexNote.ai_tags ?? detail.ai_tags,
      updated_at: indexNote.updated_at ?? detail.updated_at,
      remote_updated_at: indexNote.remote_updated_at ?? detail.remote_updated_at,
      sync_status: indexNote.sync_status ?? detail.sync_status,
      dirty: detail.dirty ?? indexNote.dirty,
      has_local_detail: true,
    });
  });
}

async function readLegacyTrashNotes(): Promise<Note[]> {
  const raw = await AsyncStorage.getItem(TRASH_STORAGE_KEY);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as Note[]).map(normalizeLocalNote);
  } catch {
    return [];
  }
}

async function writeTrashNotes(notes: Note[]): Promise<void> {
  await AsyncStorage.setItem(TRASH_STORAGE_KEY, JSON.stringify(sortNotesByFreshness(notes.map(normalizeLocalNote))));
}

async function writeNotesToSplitStore(notes: Note[], extraKeysToRemove: string[] = []): Promise<void> {
  const normalized = sortNotesByFreshness(notes.map(normalizeLocalNote));
  const indexNotes = normalized.map(toIndexNote);
  const detailPairs: [string, string][] = normalized
    .filter((note) => note.has_local_detail)
    .map((note) => [detailStorageKey(note.id), JSON.stringify(note)]);
  const staleKeys = await findStaleDetailKeys(normalized, extraKeysToRemove);

  await AsyncStorage.multiSet([
    [INDEX_STORAGE_KEY, JSON.stringify(indexNotes)],
    ...detailPairs,
  ]);
  if (staleKeys.length) {
    await AsyncStorage.multiRemove(staleKeys);
  }
  await AsyncStorage.removeItem(STORAGE_KEY);
}

async function findStaleDetailKeys(notes: Note[], extraKeysToRemove: string[]) {
  const keep = new Set(notes.filter((note) => note.has_local_detail).map((note) => detailStorageKey(note.id)));
  const allKeys = await AsyncStorage.getAllKeys();
  return allKeys.filter((key) => (key.startsWith(DETAIL_KEY_PREFIX) && !keep.has(key)) || extraKeysToRemove.includes(key));
}

function toIndexNote(note: Note): Note {
  const normalized = normalizeLocalNote(note);
  return normalizeLocalNote({
    ...normalized,
    raw_text: '',
    content_hash: normalized.content_hash ?? null,
  });
}

function sortNotesByFreshness(notes: Note[]) {
  return [...notes].sort(
    (a, b) => getNoteFreshness(b) - getNoteFreshness(a) || getDateTime(b.created_at) - getDateTime(a.created_at),
  );
}

function getNoteFreshness(note: Note) {
  return Math.max(getDateTime(note.updated_at), getDateTime(note.created_at));
}

function getDateTime(value?: string | null) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function detailStorageKey(noteId: string) {
  return `${DETAIL_KEY_PREFIX}${noteId}`;
}

function makeLocalTitle(text: string) {
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}...` : cleaned || '새 메모';
}
