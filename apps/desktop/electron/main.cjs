const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const isDev = process.env.DESKTOP_DEV_SERVER_URL;
const MANIFEST_FILE = 'manifest.json';
const VAULT_DIRS = ['notes', 'reports', path.join('attachments', 'audio')];
const MAX_SYNC_BODY_BYTES = 12 * 1024 * 1024;
let activeSyncServer = null;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    title: '생각회수기 Desktop',
    backgroundColor: '#fffdf9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(isDev);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('desktop:create-sync-session', async (_event, vaultPath) => {
    if (!vaultPath) throw new Error('Vault path is required');
    return startLocalSyncServer(vaultPath);
  });

  ipcMain.handle('desktop:stop-sync-session', async () => {
    stopLocalSyncServer();
    return { stopped: true };
  });

  ipcMain.handle('desktop:create-default-vault', async () => {
    const vaultPath = path.join(app.getPath('documents'), 'Thought Recovery Vault');
    return ensureVault(vaultPath);
  });

  ipcMain.handle('desktop:select-vault-directory', async () => {
    const result = await dialog.showOpenDialog({
      title: '생각회수기 Vault 폴더 선택',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return ensureVault(result.filePaths[0]);
  });

  ipcMain.handle('desktop:get-vault-overview', async (_event, vaultPath) => {
    if (!vaultPath) return null;
    return ensureVault(vaultPath);
  });

  ipcMain.handle('desktop:write-sample-note', async (_event, vaultPath) => {
    if (!vaultPath) throw new Error('Vault path is required');
    const now = new Date().toISOString();
    const noteId = `desktop-sample-${Date.now().toString(36)}`;
    const markdown = createSampleMarkdown(noteId, now, '데스크탑에서 만든 샘플 메모', 'Vault 파일 I/O 확인용 메모');
    const result = applySyncTransactionPackage(vaultPath, createSingleFilePackage({
      transactionId: `desktop-sample-${Date.now().toString(36)}`,
      sourceDeviceId: os.hostname(),
      relativePath: `notes/${noteId}.md`,
      content: markdown,
      now,
    }));
    return { ...result.overview, lastWrittenPath: result.applied.upserts[0] ?? null };
  });

  ipcMain.handle('desktop:apply-sync-transaction-package', async (_event, vaultPath, syncPackage) => {
    if (!vaultPath) throw new Error('Vault path is required');
    const result = applySyncTransactionPackage(vaultPath, syncPackage);
    return result;
  });

  ipcMain.handle('desktop:import-sync-transaction-package', async (_event, vaultPath) => {
    if (!vaultPath) throw new Error('Vault path is required');
    const result = await dialog.showOpenDialog({
      title: 'Sync transaction JSON 선택',
      filters: [{ name: 'Sync transaction JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const syncPackage = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    return applySyncTransactionPackage(vaultPath, syncPackage);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopLocalSyncServer();
  if (process.platform !== 'darwin') app.quit();
});

function startLocalSyncServer(vaultPath) {
  ensureVault(vaultPath);
  stopLocalSyncServer();

  const token = createSessionToken();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const server = http.createServer((request, response) => {
    handleSyncRequest({ request, response, vaultPath, token, expiresAt });
  });

  server.listen(0, '0.0.0.0');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start local sync server');
  const host = getPrimaryLanAddress();
  const url = `http://${host}:${address.port}/sync/${token}`;
  const timer = setTimeout(() => stopLocalSyncServer(), Math.max(0, expiresAt - Date.now()));
  activeSyncServer = { server, timer, token, expiresAt, url, vaultPath };
  return {
    sessionId: token,
    url,
    expiresAt,
    deviceName: os.hostname(),
  };
}

function stopLocalSyncServer() {
  if (!activeSyncServer) return;
  clearTimeout(activeSyncServer.timer);
  activeSyncServer.server.close();
  activeSyncServer = null;
}

function handleSyncRequest({ request, response, vaultPath, token, expiresAt }) {
  setCorsHeaders(response);
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === 'GET' && request.url === `/sync/${token}/status`) {
    writeJson(response, 200, { ok: true, expiresAt, deviceName: os.hostname() });
    return;
  }
  if (request.method !== 'POST' || request.url !== `/sync/${token}`) {
    writeJson(response, 404, { ok: false, error: 'Unknown sync endpoint' });
    return;
  }
  if (Date.now() > expiresAt) {
    writeJson(response, 410, { ok: false, error: 'Sync session expired' });
    stopLocalSyncServer();
    return;
  }

  let body = '';
  let bytes = 0;
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes > MAX_SYNC_BODY_BYTES) {
      request.destroy(new Error('Sync package too large'));
      return;
    }
    body += chunk;
  });
  request.on('end', () => {
    try {
      const syncPackage = JSON.parse(body);
      const result = applySyncTransactionPackage(vaultPath, syncPackage);
      writeJson(response, 200, { ok: true, transactionId: result.transactionId, applied: result.applied, counts: result.overview.counts });
    } catch (error) {
      writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  request.on('error', (error) => {
    writeJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  });
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function writeJson(response, statusCode, payload) {
  if (response.writableEnded) return;
  setCorsHeaders(response);
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function getPrimaryLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

function createSessionToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureVault(vaultPath) {
  fs.mkdirSync(vaultPath, { recursive: true });
  for (const dir of VAULT_DIRS) fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });

  const manifestPath = path.join(vaultPath, MANIFEST_FILE);
  let manifest;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } else {
    const now = new Date().toISOString();
    manifest = {
      schemaVersion: 1,
      vaultId: `local-${Date.now().toString(36)}`,
      createdAt: now,
      updatedAt: now,
      notesPath: 'notes',
      reportsPath: 'reports',
      audioPath: 'attachments/audio',
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  return {
    vaultPath,
    manifest,
    counts: {
      notes: countMarkdownFiles(path.join(vaultPath, 'notes')),
      reports: countMarkdownFiles(path.join(vaultPath, 'reports')),
      audio: countFiles(path.join(vaultPath, 'attachments', 'audio')),
    },
  };
}

function applySyncTransactionPackage(vaultPath, syncPackage) {
  ensureVault(vaultPath);
  validateSyncPackageShape(syncPackage);

  const applied = { upserts: [], deletes: [], skipped: [] };
  for (const file of syncPackage.transaction.files) {
    const relativePath = normalizeVaultRelativePath(file.path);
    const targetPath = resolveVaultPath(vaultPath, relativePath);
    const existingUpdatedAt = readExistingVaultUpdatedAt(targetPath);
    const incomingUpdatedAt = parseTime(file.updatedAt) ?? parseTime(syncPackage.transaction.createdAt) ?? Date.now();
    if (existingUpdatedAt !== null && existingUpdatedAt >= incomingUpdatedAt) {
      applied.skipped.push({ path: relativePath, reason: 'existing-newer-or-same' });
      continue;
    }

    if (file.operation === 'delete') {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      applied.deletes.push(relativePath);
      continue;
    }

    const content = syncPackage.files[relativePath] ?? syncPackage.files[file.path];
    if (typeof content !== 'string') throw new Error(`Missing file content: ${relativePath}`);
    const hash = computeContentHash(content);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (hash !== file.hash) throw new Error(`Hash mismatch: ${relativePath}`);
    if (bytes !== file.bytes) throw new Error(`Size mismatch: ${relativePath}`);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
    applied.upserts.push(relativePath);
  }

  touchManifest(vaultPath);
  return {
    transactionId: syncPackage.transaction.transactionId,
    applied,
    overview: ensureVault(vaultPath),
  };
}

function validateSyncPackageShape(syncPackage) {
  if (!syncPackage || typeof syncPackage !== 'object') throw new Error('Invalid sync package');
  if (!syncPackage.transaction || typeof syncPackage.transaction !== 'object') throw new Error('Missing transaction');
  if (syncPackage.transaction.schemaVersion !== 1) throw new Error('Unsupported sync transaction schema version');
  if (!Array.isArray(syncPackage.transaction.files)) throw new Error('Missing transaction files');
  if (!syncPackage.files || typeof syncPackage.files !== 'object') throw new Error('Missing package file contents');
}

function createSingleFilePackage({ transactionId, sourceDeviceId, relativePath, content, now }) {
  const normalizedPath = normalizeVaultRelativePath(relativePath);
  return {
    transaction: {
      schemaVersion: 1,
      transactionId,
      sourceDeviceId,
      createdAt: now,
      files: [{
        path: normalizedPath,
        operation: 'upsert',
        hash: computeContentHash(content),
        bytes: Buffer.byteLength(content, 'utf8'),
        updatedAt: now,
      }],
    },
    files: { [normalizedPath]: content },
  };
}

function createSampleMarkdown(noteId, now, title, summary) {
  return [
    '---',
    `id: ${noteId}`,
    'type: note',
    `createdAt: ${now}`,
    `updatedAt: ${now}`,
    'deletedAt: null',
    `title: ${JSON.stringify(title)}`,
    `summary: ${JSON.stringify(summary)}`,
    'tags:',
    '  - desktop',
    '  - vault',
    'audioIds:',
    '---',
    '',
    '이 메모는 데스크탑 앱이 Vault 폴더에 sync transaction을 적용할 수 있는지 확인하기 위한 샘플입니다.',
    '',
  ].join('\n');
}

function touchManifest(vaultPath) {
  const manifestPath = path.join(vaultPath, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
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

function normalizeVaultRelativePath(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) throw new Error(`Unsafe vault path: ${value}`);
  return parts.join('/');
}

function resolveVaultPath(vaultPath, relativePath) {
  const targetPath = path.resolve(vaultPath, normalizeVaultRelativePath(relativePath));
  const rootPath = path.resolve(vaultPath);
  if (!targetPath.startsWith(rootPath + path.sep)) throw new Error(`Unsafe vault path: ${relativePath}`);
  return targetPath;
}

function computeContentHash(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function countMarkdownFiles(dir) {
  return safeReaddir(dir).filter((name) => name.toLowerCase().endsWith('.md')).length;
}

function countFiles(dir) {
  return safeReaddir(dir).filter((name) => fs.statSync(path.join(dir, name)).isFile()).length;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
