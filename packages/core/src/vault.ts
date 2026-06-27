import { Note, MergedThoughtDraft } from './types';

export type VaultEntityType = 'note' | 'report';

export type VaultMarkdownEntity = {
  id: string;
  type: VaultEntityType;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  title: string;
  summary: string;
  tags: string[];
  audioIds: string[];
  body: string;
};

export type VaultManifest = {
  schemaVersion: 1;
  vaultId: string;
  createdAt: string;
  updatedAt: string;
  notesPath: 'notes';
  reportsPath: 'reports';
  audioPath: 'attachments/audio';
};

export type SyncPackageManifest = {
  schemaVersion: 1;
  packageId: string;
  sourceDeviceId: string;
  createdAt: string;
  files: Array<{
    path: string;
    hash: string;
    bytes: number;
  }>;
};

export function createVaultManifest(vaultId: string, now = new Date().toISOString()): VaultManifest {
  return {
    schemaVersion: 1,
    vaultId,
    createdAt: now,
    updatedAt: now,
    notesPath: 'notes',
    reportsPath: 'reports',
    audioPath: 'attachments/audio',
  };
}

export function noteToVaultEntity(note: Note): VaultMarkdownEntity {
  return {
    id: note.id,
    type: 'note',
    createdAt: note.created_at,
    updatedAt: note.updated_at ?? note.created_at,
    deletedAt: note.deleted_at ?? null,
    title: note.ai_title ?? '',
    summary: note.ai_summary ?? '',
    tags: note.ai_tags ?? [],
    audioIds: note.local_audio_url || note.audio_url ? [makeAudioId(note)] : [],
    body: note.raw_text ?? '',
  };
}

export function reportToVaultEntity(draft: MergedThoughtDraft): VaultMarkdownEntity {
  return {
    id: draft.id,
    type: 'report',
    createdAt: draft.createdAt,
    updatedAt: draft.createdAt,
    deletedAt: null,
    title: draft.title,
    summary: draft.judgmentSummary[0] ?? '',
    tags: [],
    audioIds: [],
    body: draft.body,
  };
}

export function getVaultMarkdownPath(entity: Pick<VaultMarkdownEntity, 'id' | 'type'>): string {
  const dir = entity.type === 'report' ? 'reports' : 'notes';
  return `${dir}/${sanitizeFileId(entity.id)}.md`;
}

export function getVaultAudioPath(audioId: string, extension = 'm4a'): string {
  return `attachments/audio/${sanitizeFileId(audioId)}.${sanitizeFileExtension(extension)}`;
}

export function serializeVaultMarkdown(entity: VaultMarkdownEntity): string {
  const frontmatter = [
    '---',
    `id: ${escapeScalar(entity.id)}`,
    `type: ${entity.type}`,
    `createdAt: ${escapeScalar(entity.createdAt)}`,
    `updatedAt: ${escapeScalar(entity.updatedAt)}`,
    `deletedAt: ${entity.deletedAt ? escapeScalar(entity.deletedAt) : 'null'}`,
    `title: ${escapeScalar(entity.title)}`,
    `summary: ${escapeScalar(entity.summary)}`,
    ...serializeStringArray('tags', entity.tags),
    ...serializeStringArray('audioIds', entity.audioIds),
    '---',
    '',
  ];
  return `${frontmatter.join('\n')}${entity.body.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

export function parseVaultMarkdown(markdown: string): VaultMarkdownEntity {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('Vault markdown is missing YAML frontmatter');
  }
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) throw new Error('Vault markdown frontmatter is not closed');

  const frontmatter = normalized.slice(4, end).trim();
  const body = normalized.slice(end + '\n---'.length).replace(/^\n/, '').trimEnd();
  const data = parseSimpleYaml(frontmatter);
  const type = data.type === 'report' ? 'report' : data.type === 'note' ? 'note' : null;
  if (!type) throw new Error(`Unsupported vault entity type: ${String(data.type)}`);

  return {
    id: requireScalar(data.id, 'id'),
    type,
    createdAt: requireScalar(data.createdAt, 'createdAt'),
    updatedAt: requireScalar(data.updatedAt, 'updatedAt'),
    deletedAt: data.deletedAt && data.deletedAt !== 'null' ? String(data.deletedAt) : null,
    title: String(data.title ?? ''),
    summary: String(data.summary ?? ''),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    audioIds: Array.isArray(data.audioIds) ? data.audioIds.map(String) : [],
    body,
  };
}

export function updateVaultMarkdownBody(markdown: string, nextBody: string): string {
  const entity = parseVaultMarkdown(markdown);
  return serializeVaultMarkdown({
    ...entity,
    body: nextBody,
    updatedAt: new Date().toISOString(),
  });
}

export function computeContentHash(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function validateSyncPackageManifest(manifest: SyncPackageManifest, fileContents: Record<string, string | Uint8Array>): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== 1) errors.push('Unsupported sync package schema version');
  for (const file of manifest.files) {
    const content = fileContents[file.path];
    if (content === undefined) {
      errors.push(`Missing file: ${file.path}`);
      continue;
    }
    const actualHash = computeContentHash(content);
    if (actualHash !== file.hash) errors.push(`Hash mismatch: ${file.path}`);
    const actualBytes = typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
    if (actualBytes !== file.bytes) errors.push(`Size mismatch: ${file.path}`);
  }
  return errors;
}

function parseSimpleYaml(source: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = source.split('\n');
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const arrayItem = line.match(/^\s+-\s*(.*)$/);
    if (arrayItem && currentArrayKey) {
      (result[currentArrayKey] as string[]).push(unescapeScalar(arrayItem[1] ?? ''));
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) throw new Error(`Unsupported frontmatter line: ${line}`);
    const key = pair[1];
    const value = pair[2] ?? '';
    if (value === '') {
      result[key] = [];
      currentArrayKey = key;
      continue;
    }
    result[key] = unescapeScalar(value);
    currentArrayKey = null;
  }

  return result;
}

function serializeStringArray(key: string, values: string[]) {
  if (!values.length) return [`${key}:`];
  return [`${key}:`, ...values.map((value) => `  - ${escapeScalar(value)}`)];
}

function requireScalar(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required frontmatter field: ${key}`);
  return value;
}

function escapeScalar(value: string) {
  if (!value) return '""';
  if (/[:#\n\r]|^\s|\s$|^-|^null$/.test(value)) return JSON.stringify(value);
  return value;
}

function unescapeScalar(value: string) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function sanitizeFileId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function sanitizeFileExtension(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'bin';
}

function makeAudioId(note: Note) {
  return `audio-${sanitizeFileId(note.id)}`;
}
