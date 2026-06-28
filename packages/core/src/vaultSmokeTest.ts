import { createSyncTransaction, validateSyncTransaction } from './syncTransaction';
import { computeContentHash, parseVaultMarkdown, serializeVaultMarkdown, validateSyncPackageManifest, VaultMarkdownEntity } from './vault';

export function runVaultSmokeTest() {
  const entity: VaultMarkdownEntity = {
    id: 'note-sample-1',
    type: 'note',
    createdAt: '2026-06-27T00:00:00.000Z',
    updatedAt: '2026-06-27T00:01:00.000Z',
    deletedAt: null,
    title: 'Sample note',
    summary: 'A short summary',
    tags: ['sample', 'sync'],
    audioIds: ['audio-note-sample-1'],
    body: 'A body that users can edit.',
  };

  const markdown = serializeVaultMarkdown(entity);
  const parsed = parseVaultMarkdown(markdown);
  assert(parsed.id === entity.id, 'id roundtrip failed');
  assert(parsed.type === entity.type, 'type roundtrip failed');
  assert(parsed.body === entity.body, 'body roundtrip failed');
  assert(parsed.tags.join(',') === entity.tags.join(','), 'tags roundtrip failed');
  assert(parsed.audioIds.join(',') === entity.audioIds.join(','), 'audioIds roundtrip failed');

  const hash = computeContentHash(markdown);
  const errors = validateSyncPackageManifest({
    schemaVersion: 1,
    packageId: 'pkg-1',
    sourceDeviceId: 'desktop-1',
    createdAt: '2026-06-27T00:02:00.000Z',
    files: [{ path: 'notes/note-sample-1.md', hash, bytes: new TextEncoder().encode(markdown).byteLength }],
  }, { 'notes/note-sample-1.md': markdown });
  assert(errors.length === 0, `manifest validation failed: ${errors.join('; ')}`);

  const transaction = createSyncTransaction({
    transactionId: 'tx-1',
    sourceDeviceId: 'desktop-1',
    now: '2026-06-27T00:03:00.000Z',
    files: [{ path: 'notes/note-sample-1.md', content: markdown }],
  });
  const transactionResult = validateSyncTransaction(transaction, { 'notes/note-sample-1.md': markdown });
  assert(transactionResult.ok, `transaction validation failed: ${transactionResult.errors.join('; ')}`);

  return { ok: true, hash, transactionId: transaction.transactionId };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
