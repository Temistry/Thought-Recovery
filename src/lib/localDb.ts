import * as SQLite from 'expo-sqlite';
import { MergedThoughtDraft, Note, ThoughtFlow } from '../types';

const DB_NAME = 'idea-second-brain.db';
const SCHEMA_VERSION = 1;

type NoteRow = {
  id: string;
  deleted_at: string | null;
  payload: string;
};

type ThoughtFlowRow = {
  id: string;
  payload: string;
  draft_payload: string | null;
};

export type LocalDbListNotesOptions = {
  deleted?: boolean;
  limit?: number;
  fromCreatedAt?: string;
  search?: string;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getLocalDb() {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync('PRAGMA journal_mode = WAL;');
      await db.execAsync('PRAGMA foreign_keys = ON;');
      await db.execAsync(`
        create table if not exists app_meta (
          key text primary key not null,
          value text
        );
        create table if not exists notes (
          id text primary key not null,
          user_id text,
          parent_note_id text,
          source_type text not null,
          created_at text not null,
          updated_at text,
          deleted_at text,
          has_local_detail integer not null default 0,
          dirty integer not null default 0,
          payload text not null
        );
        create index if not exists notes_active_updated_idx on notes(deleted_at, updated_at desc, created_at desc);
        create table if not exists thought_flows (
          id text primary key not null,
          title text not null,
          status text not null,
          updated_at text not null,
          source_note_ids text not null default '[]',
          payload text not null
        );
        create table if not exists thought_flow_notes (
          flow_id text not null,
          note_id text not null,
          position integer not null default 0,
          primary key(flow_id, note_id)
        );
        create table if not exists thought_flow_drafts (
          flow_id text primary key not null,
          draft_id text not null,
          title text not null,
          created_at text not null,
          payload text not null
        );
        create index if not exists notes_active_created_idx on notes(deleted_at, created_at desc);
        create index if not exists notes_parent_idx on notes(parent_note_id);
        create index if not exists notes_deleted_idx on notes(deleted_at desc);
        create index if not exists thought_flows_updated_idx on thought_flows(updated_at desc);
        create index if not exists thought_flow_notes_note_idx on thought_flow_notes(note_id);
      `);
      await ensureThoughtFlowSourceColumn(db);
      const row = await db.getFirstAsync<{ value: string }>('select value from app_meta where key = ?', ['schema_version']);
      if (!row) {
        await db.runAsync('insert or replace into app_meta(key, value) values(?, ?)', ['schema_version', String(SCHEMA_VERSION)]);
      }
      return db;
    });
  }
  return dbPromise;
}

export async function isLocalDbMigratedFromAsyncStorage() {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<{ value: string }>('select value from app_meta where key = ?', ['async_storage_migrated']);
  return row?.value === 'true';
}

export async function markLocalDbMigratedFromAsyncStorage() {
  const db = await getLocalDb();
  await db.runAsync('insert or replace into app_meta(key, value) values(?, ?)', ['async_storage_migrated', 'true']);
}

export async function getLocalDbNoteCount() {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<{ count: number }>('select count(*) as count from notes');
  return row?.count ?? 0;
}

export async function listLocalDbNotes(options: LocalDbListNotesOptions = {}): Promise<Note[]> {
  const db = await getLocalDb();
  const deleted = options.deleted ?? false;
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : null;
  const where: string[] = [deleted ? 'deleted_at is not null' : 'deleted_at is null'];
  const params: SQLite.SQLiteBindValue[] = [];

  if (options.fromCreatedAt) {
    where.push('created_at >= ?');
    params.push(options.fromCreatedAt);
  }

  if (options.search?.trim()) {
    const query = `%${options.search.trim().toLowerCase()}%`;
    where.push('lower(payload) like ?');
    params.push(query);
  }

  const sql = `
    select id, deleted_at, payload
    from notes
    where ${where.join(' and ')}
    order by coalesce(updated_at, created_at) desc, created_at desc
    ${limit ? `limit ${limit}` : ''}
  `;
  const rows = await db.getAllAsync<NoteRow>(sql, params);
  return rows.map(rowToNote).filter((note): note is Note => !!note);
}

export async function readLocalDbValue<T>(key: string): Promise<T | null> {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<{ value: string }>('select value from app_meta where key = ?', [key]);
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function writeLocalDbValue<T>(key: string, value: T): Promise<void> {
  const db = await getLocalDb();
  await db.runAsync('insert or replace into app_meta(key, value) values(?, ?)', [key, JSON.stringify(value)]);
}

export async function replaceLocalDbActiveNotes(notes: Note[]) {
  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('delete from notes where deleted_at is null');
    for (const note of notes) {
      await upsertLocalDbNoteInTransaction(db, { ...note, deleted_at: null });
    }
  });
}

export async function upsertLocalDbNotes(notes: Note[]) {
  if (!notes.length) return;
  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    for (const note of notes) {
      await upsertLocalDbNoteInTransaction(db, note);
    }
  });
}

export async function moveLocalDbNoteToTrash(note: Note): Promise<Note> {
  const deletedAt = new Date().toISOString();
  const trashed = { ...note, deleted_at: deletedAt };
  const db = await getLocalDb();
  await upsertLocalDbNoteInTransaction(db, trashed);
  return trashed;
}

export async function restoreLocalDbTrashNote(noteId: string): Promise<Note | null> {
  const db = await getLocalDb();
  const row = await db.getFirstAsync<NoteRow>('select id, deleted_at, payload from notes where id = ? and deleted_at is not null', [noteId]);
  const note = row ? rowToNote(row) : null;
  if (!note) return null;
  const restored = { ...note, deleted_at: null, updated_at: new Date().toISOString() };
  await upsertLocalDbNoteInTransaction(db, restored);
  return restored;
}

export async function deleteLocalDbNote(noteId: string) {
  const db = await getLocalDb();
  await db.runAsync('delete from notes where id = ?', [noteId]);
}

export async function readLocalDbTrashNoteIds() {
  const db = await getLocalDb();
  const rows = await db.getAllAsync<{ id: string }>('select id from notes where deleted_at is not null');
  return new Set(rows.map((row) => row.id));
}

export async function listLocalDbThoughtFlows(limit = 20): Promise<ThoughtFlow[]> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync<ThoughtFlowRow>(
    `select f.id, f.payload, d.payload as draft_payload
     from thought_flows f
     left join thought_flow_drafts d on d.flow_id = f.id
     order by f.updated_at desc
     limit ?`,
    [Math.max(1, Math.floor(limit))],
  );
  return rows.map(rowToThoughtFlow).filter((flow): flow is ThoughtFlow => !!flow);
}

export async function replaceLocalDbThoughtFlows(flows: ThoughtFlow[]) {
  const db = await getLocalDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('delete from thought_flow_notes');
    await db.runAsync('delete from thought_flows');
    for (const flow of flows) {
      await upsertLocalDbThoughtFlowInTransaction(db, flow);
    }
  });
}

export async function upsertLocalDbThoughtDraft(draft: MergedThoughtDraft) {
  const db = await getLocalDb();
  await db.runAsync(
    `insert or replace into thought_flow_drafts(flow_id, draft_id, title, created_at, payload)
     values(?, ?, ?, ?, ?)`,
    [draft.flowId, draft.id, draft.title, draft.createdAt, JSON.stringify(draft)],
  );
}

export async function listLocalDbThoughtDrafts(): Promise<Record<string, MergedThoughtDraft>> {
  const db = await getLocalDb();
  const rows = await db.getAllAsync<{ flow_id: string; payload: string }>('select flow_id, payload from thought_flow_drafts');
  const drafts: Record<string, MergedThoughtDraft> = {};
  for (const row of rows) {
    try {
      drafts[row.flow_id] = JSON.parse(row.payload) as MergedThoughtDraft;
    } catch {
      // Ignore one malformed draft row.
    }
  }
  return drafts;
}

async function ensureThoughtFlowSourceColumn(db: SQLite.SQLiteDatabase) {
  const columns = await db.getAllAsync<{ name: string }>('pragma table_info(thought_flows)');
  if (columns.some((column) => column.name === 'source_note_ids')) return;
  await db.runAsync("alter table thought_flows add column source_note_ids text not null default '[]'");
}

async function upsertLocalDbNoteInTransaction(db: SQLite.SQLiteDatabase, note: Note) {
  await db.runAsync(
    `insert or replace into notes(
      id, user_id, parent_note_id, source_type, created_at, updated_at, deleted_at, has_local_detail, dirty, payload
    ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      note.id,
      note.user_id ?? null,
      note.parent_note_id ?? null,
      note.source_type,
      note.created_at,
      note.updated_at ?? note.created_at,
      note.deleted_at ?? null,
      note.has_local_detail ? 1 : 0,
      note.dirty ? 1 : 0,
      JSON.stringify(note),
    ],
  );
}

async function upsertLocalDbThoughtFlowInTransaction(db: SQLite.SQLiteDatabase, flow: ThoughtFlow) {
  await db.runAsync(
    `insert or replace into thought_flows(id, title, status, updated_at, source_note_ids, payload)
     values(?, ?, ?, ?, ?, ?)`,
    [flow.id, flow.title, flow.status, flow.updatedAt, JSON.stringify(flow.noteIds), JSON.stringify(flow)],
  );
  for (const [index, noteId] of flow.noteIds.entries()) {
    await db.runAsync(
      'insert or replace into thought_flow_notes(flow_id, note_id, position) values(?, ?, ?)',
      [flow.id, noteId, index],
    );
  }
}

function rowToNote(row: NoteRow): Note | null {
  try {
    const note = JSON.parse(row.payload) as Note;
    return { ...note, deleted_at: row.deleted_at ?? note.deleted_at ?? null };
  } catch {
    return null;
  }
}

function rowToThoughtFlow(row: ThoughtFlowRow): ThoughtFlow | null {
  try {
    const flow = JSON.parse(row.payload) as ThoughtFlow;
    if (!row.draft_payload) return flow;
    const draft = JSON.parse(row.draft_payload) as MergedThoughtDraft;
    return {
      ...flow,
      title: draft.title || flow.title,
      status: draft.status === 'saved' ? 'saved' : flow.status,
      updatedAt: draft.createdAt || flow.updatedAt,
      mergedDraft: draft,
    };
  } catch {
    return null;
  }
}
