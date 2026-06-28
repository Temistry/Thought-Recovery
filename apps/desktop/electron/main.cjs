const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isDev = process.env.DESKTOP_DEV_SERVER_URL;
const MANIFEST_FILE = 'manifest.json';
const VAULT_DIRS = ['notes', 'reports', path.join('attachments', 'audio')];

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
  ipcMain.handle('desktop:create-sync-session', async () => ({
    sessionId: `local-${Date.now().toString(36)}`,
    expiresAt: Date.now() + 5 * 60 * 1000,
    deviceName: os.hostname(),
  }));

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
    const overview = ensureVault(vaultPath);
    const now = new Date().toISOString();
    const noteId = `desktop-sample-${Date.now().toString(36)}`;
    const notePath = path.join(vaultPath, 'notes', `${noteId}.md`);
    const markdown = [
      '---',
      `id: ${noteId}`,
      'type: note',
      `createdAt: ${now}`,
      `updatedAt: ${now}`,
      'deletedAt: null',
      'title: "데스크탑에서 만든 샘플 메모"',
      'summary: "Vault 파일 I/O 확인용 메모"',
      'tags:',
      '  - desktop',
      '  - vault',
      'audioIds:',
      '---',
      '',
      '이 메모는 데스크탑 앱이 Vault 폴더에 직접 Markdown 파일을 쓸 수 있는지 확인하기 위한 샘플입니다.',
      '',
    ].join('\n');
    fs.writeFileSync(notePath, markdown, 'utf8');
    return { ...ensureVault(vaultPath), lastWrittenPath: path.relative(vaultPath, notePath).replace(/\\/g, '/') };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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
