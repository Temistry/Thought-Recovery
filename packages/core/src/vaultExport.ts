import { MergedThoughtDraft, Note } from './types';
import { getVaultMarkdownPath, noteToVaultEntity, reportToVaultEntity, serializeVaultMarkdown } from './vault';
import { createSyncTransactionPackage, SyncTransactionPackage } from './syncTransaction';

export type VaultExportSource = {
  notes: Note[];
  drafts?: Record<string, MergedThoughtDraft>;
  sourceDeviceId: string;
  transactionId?: string;
  now?: string;
};

export type VaultExportSummary = {
  noteCount: number;
  reportCount: number;
  fileCount: number;
  transactionId: string;
};

export type VaultExportResult = {
  syncPackage: SyncTransactionPackage;
  summary: VaultExportSummary;
};

export function createVaultExportPackage(source: VaultExportSource): VaultExportResult {
  const now = source.now ?? new Date().toISOString();
  const transactionId = source.transactionId ?? `mobile-export-${Date.now().toString(36)}`;
  const noteFiles = source.notes
    .filter((note) => !note.deleted_at)
    .map((note) => {
      const entity = noteToVaultEntity(note);
      return {
        path: getVaultMarkdownPath(entity),
        content: serializeVaultMarkdown(entity),
        updatedAt: entity.updatedAt,
      };
    });

  const drafts = Object.values(source.drafts ?? {}).filter((draft) => draft.status !== 'draft' || draft.body.trim().length > 0);
  const reportFiles = drafts.map((draft) => {
    const entity = reportToVaultEntity(draft);
    return {
      path: getVaultMarkdownPath(entity),
      content: serializeVaultMarkdown(entity),
      updatedAt: entity.updatedAt,
    };
  });

  const files = [...noteFiles, ...reportFiles];
  const syncPackage = createSyncTransactionPackage({
    transactionId,
    sourceDeviceId: source.sourceDeviceId,
    now,
    files,
  });

  return {
    syncPackage,
    summary: {
      noteCount: noteFiles.length,
      reportCount: reportFiles.length,
      fileCount: files.length,
      transactionId: syncPackage.transaction.transactionId,
    },
  };
}
