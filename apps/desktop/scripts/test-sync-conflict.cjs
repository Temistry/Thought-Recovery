const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thought-recovery-sync-'));
const notePath = path.join(tempRoot, 'notes', 'same-note.md');
fs.mkdirSync(path.dirname(notePath), { recursive: true });

const newerExisting = makeMarkdown('same-note', '2026-06-28T10:00:00.000Z', 'newer desktop copy');
const olderIncoming = makeMarkdown('same-note', '2026-06-28T09:00:00.000Z', 'older mobile copy');
const latestIncoming = makeMarkdown('same-note', '2026-06-28T11:00:00.000Z', 'latest mobile copy');
fs.writeFileSync(notePath, newerExisting, 'utf8');

const skipped = applyWithUpdatedAtPolicy(notePath, olderIncoming, '2026-06-28T09:00:00.000Z');
assert(skipped === 'skipped', 'older incoming should be skipped');
assert(fs.readFileSync(notePath, 'utf8').includes('newer desktop copy'), 'newer desktop content should remain');

const applied = applyWithUpdatedAtPolicy(notePath, latestIncoming, '2026-06-28T11:00:00.000Z');
assert(applied === 'upserted', 'latest incoming should be applied');
assert(fs.readFileSync(notePath, 'utf8').includes('latest mobile copy'), 'latest mobile content should replace existing');

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('sync conflict policy ok');

function applyWithUpdatedAtPolicy(targetPath, content, incomingUpdatedAt) {
  const existingUpdatedAt = readExistingVaultUpdatedAt(targetPath);
  const incomingTime = parseTime(incomingUpdatedAt);
  if (existingUpdatedAt !== null && existingUpdatedAt >= incomingTime) return 'skipped';
  fs.writeFileSync(targetPath, content, 'utf8');
  return 'upserted';
}

function readExistingVaultUpdatedAt(targetPath) {
  if (!fs.existsSync(targetPath) || !targetPath.toLowerCase().endsWith('.md')) return null;
  const markdown = fs.readFileSync(targetPath, 'utf8').replace(/^\uFEFF/, '');
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;
  const updatedAtLine = frontmatterMatch[1].split('\n').find((line) => /^updatedAt:\s*/.test(line));
  if (!updatedAtLine) return null;
  const rawValue = updatedAtLine.replace(/^updatedAt:\s*/, '').trim().replace(/^['"]|['"]$/g, '');
  return parseTime(rawValue);
}

function parseTime(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : null;
}

function makeMarkdown(id, updatedAt, body) {
  return [
    '---',
    `id: ${id}`,
    'type: note',
    'createdAt: 2026-06-28T08:00:00.000Z',
    `updatedAt: ${updatedAt}`,
    'deletedAt: null',
    'title: Conflict sample',
    'summary: Conflict sample',
    'tags:',
    'audioIds:',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
