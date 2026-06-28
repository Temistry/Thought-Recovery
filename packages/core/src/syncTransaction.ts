import { computeContentHash } from './vault';

export type SyncOperationType = 'upsert' | 'delete';

export type SyncTransactionFile = {
  path: string;
  operation: SyncOperationType;
  hash: string;
  bytes: number;
  updatedAt: string;
};

export type SyncTransaction = {
  schemaVersion: 1;
  transactionId: string;
  sourceDeviceId: string;
  createdAt: string;
  files: SyncTransactionFile[];
};

export type SyncTransactionValidationResult = {
  ok: boolean;
  errors: string[];
};

export function createSyncTransaction(params: {
  transactionId: string;
  sourceDeviceId: string;
  files: Array<{ path: string; content: string | Uint8Array; operation?: SyncOperationType; updatedAt?: string }>;
  now?: string;
}): SyncTransaction {
  const createdAt = params.now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    transactionId: params.transactionId,
    sourceDeviceId: params.sourceDeviceId,
    createdAt,
    files: params.files.map((file) => ({
      path: normalizeVaultRelativePath(file.path),
      operation: file.operation ?? 'upsert',
      hash: computeContentHash(file.content),
      bytes: getByteLength(file.content),
      updatedAt: file.updatedAt ?? createdAt,
    })),
  };
}

export function validateSyncTransaction(
  transaction: SyncTransaction,
  fileContents: Record<string, string | Uint8Array>,
): SyncTransactionValidationResult {
  const errors: string[] = [];
  if (transaction.schemaVersion !== 1) errors.push('Unsupported sync transaction schema version');
  if (!transaction.transactionId.trim()) errors.push('Missing transaction id');
  if (!transaction.sourceDeviceId.trim()) errors.push('Missing source device id');

  const seenPaths = new Set<string>();
  for (const file of transaction.files) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeVaultRelativePath(file.path);
    } catch {
      errors.push(`Unsafe file path: ${file.path}`);
      continue;
    }
    if (seenPaths.has(normalizedPath)) errors.push(`Duplicate file operation: ${normalizedPath}`);
    seenPaths.add(normalizedPath);

    if (file.path !== normalizedPath) errors.push(`Unsafe file path: ${file.path}`);
    if (file.operation !== 'upsert' && file.operation !== 'delete') errors.push(`Unsupported operation: ${String(file.operation)}`);

    const content = fileContents[normalizedPath] ?? fileContents[file.path];
    if (file.operation === 'delete') continue;
    if (content === undefined) {
      errors.push(`Missing file content: ${normalizedPath}`);
      continue;
    }

    const actualHash = computeContentHash(content);
    if (actualHash !== file.hash) errors.push(`Hash mismatch: ${normalizedPath}`);
    const actualBytes = getByteLength(content);
    if (actualBytes !== file.bytes) errors.push(`Size mismatch: ${normalizedPath}`);
  }

  return { ok: errors.length === 0, errors };
}

export function normalizeVaultRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Unsafe vault path: ${path}`);
  }
  return parts.join('/');
}

function getByteLength(content: string | Uint8Array): number {
  return typeof content === 'string' ? new TextEncoder().encode(content).byteLength : content.byteLength;
}
