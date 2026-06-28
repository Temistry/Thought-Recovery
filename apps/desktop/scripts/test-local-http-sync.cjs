const http = require('http');

const token = `test-${Date.now().toString(36)}`;
const received = [];
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== `/sync/${token}`) {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: false }));
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const syncPackage = JSON.parse(body);
    assert(syncPackage.transaction.schemaVersion === 1, 'schema version mismatch');
    assert(syncPackage.transaction.files.length === 1, 'file count mismatch');
    assert(syncPackage.files['notes/http-test.md'].includes('HTTP sync test'), 'content mismatch');
    received.push(syncPackage.transaction.transactionId);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, applied: { upserts: ['notes/http-test.md'], deletes: [], skipped: [] } }));
  });
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/sync/${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makePackage()),
  });
  const result = await response.json();
  assert(response.ok, 'HTTP response failed');
  assert(result.ok === true, 'sync result failed');
  assert(received.length === 1, 'server did not receive package');
  server.close(() => {
    console.log('local http sync roundtrip ok');
  });
});

function makePackage() {
  const content = [
    '---',
    'id: http-test',
    'type: note',
    'createdAt: 2026-06-28T00:00:00.000Z',
    'updatedAt: 2026-06-28T00:01:00.000Z',
    'deletedAt: null',
    'title: HTTP sync test',
    'summary: HTTP sync test',
    'tags:',
    'audioIds:',
    '---',
    '',
    'HTTP sync test',
    '',
  ].join('\n');
  return {
    transaction: {
      schemaVersion: 1,
      transactionId: 'http-roundtrip-test',
      sourceDeviceId: 'test-device',
      createdAt: '2026-06-28T00:02:00.000Z',
      files: [{ path: 'notes/http-test.md', operation: 'upsert', hash: computeContentHash(content), bytes: Buffer.byteLength(content, 'utf8'), updatedAt: '2026-06-28T00:01:00.000Z' }],
    },
    files: { 'notes/http-test.md': content },
  };
}

function computeContentHash(content) {
  const bytes = Buffer.from(String(content), 'utf8');
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
