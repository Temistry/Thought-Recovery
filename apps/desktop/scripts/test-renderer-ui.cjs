const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const preloadPath = path.join(os.tmpdir(), `thought-recovery-ui-test-preload-${process.pid}.cjs`);

fs.writeFileSync(preloadPath, `
const { contextBridge } = require('electron');
let vaultOverview = null;
let sampleIndex = 0;
contextBridge.exposeInMainWorld('thoughtRecoveryDesktop', {
  async createDefaultVault() {
    vaultOverview = { vaultPath: 'C:/QA/Thought Recovery Vault', counts: { notes: 0, reports: 0, audio: 0 } };
    return vaultOverview;
  },
  async selectVaultDirectory() {
    vaultOverview = { vaultPath: 'C:/QA/Selected Vault', counts: { notes: 2, reports: 1, audio: 0 } };
    return vaultOverview;
  },
  async writeSampleNote() {
    sampleIndex += 1;
    vaultOverview = { ...(vaultOverview ?? { vaultPath: 'C:/QA/Thought Recovery Vault' }), counts: { notes: sampleIndex, reports: 0, audio: 0 }, lastWrittenPath: 'notes/sample-' + sampleIndex + '.md' };
    return vaultOverview;
  },
  async createSyncSession() {
    return { sessionId: 'qa-session', url: 'http://127.0.0.1:49152/sync/qa-session', expiresAt: Date.now() + 300000, deviceName: 'qa-pc' };
  },
  async stopSyncSession() {
    return { stopped: true };
  },
  async applySyncTransactionPackage(vaultPath, syncPackage) {
    vaultOverview = { vaultPath, counts: { notes: 3, reports: 1, audio: 0 } };
    return { transactionId: syncPackage.transaction.transactionId, overview: vaultOverview, applied: { upserts: ['notes/preview.md'], deletes: [], skipped: [] } };
  },
  async importSyncTransactionPackage(vaultPath) {
    vaultOverview = { vaultPath, counts: { notes: 4, reports: 1, audio: 0 } };
    return { transactionId: 'import-transaction', overview: vaultOverview, applied: { upserts: ['notes/import.md'], deletes: [], skipped: [] } };
  }
});
`, 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function evalInWindow(window, fn, ...args) {
  return window.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`, true);
}

async function waitFor(window, fn, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await evalInWindow(window, fn);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for renderer condition');
}

async function clickButton(window, label) {
  const clicked = await evalInWindow(window, (buttonLabel) => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === buttonLabel);
    if (!button) return false;
    button.click();
    return true;
  }, label);
  assert(clicked, `Button not found: ${label}`);
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function getText(window, selector) {
  return evalInWindow(window, (cssSelector) => document.querySelector(cssSelector)?.textContent ?? '', selector);
}

async function run() {
  await app.whenReady();

  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await waitFor(window, () => document.querySelectorAll('.navButton').length === 4);

  assert((await getText(window, 'h2')).includes('모바일에서 회수한 생각'), 'Initial Vault hero is wrong');

  await clickButton(window, 'Search');
  assert((await getText(window, 'h2')).includes('PC에 저장된 생각'), 'Search tab did not activate');
  assert((await getText(window, '.grid')).includes('Vault가 필요합니다'), 'Search empty state is missing');
  await clickButton(window, 'Vault 선택');
  await waitFor(window, () => document.querySelector('.grid')?.textContent.includes('검색 준비됨'));
  assert((await getText(window, '.grid')).includes('검색 준비됨'), 'Search vault selection did not update state');

  await clickButton(window, 'Vault');
  assert((await getText(window, 'h2')).includes('모바일에서 회수한 생각'), 'Vault tab did not activate');
  await clickButton(window, '기본 Vault 만들기');
  await waitFor(window, () => document.querySelector('.grid')?.textContent.includes('Vault 연결됨'));
  assert((await getText(window, '.grid')).includes('Vault 연결됨'), 'Create default vault did not update state');
  await clickButton(window, '샘플 메모 쓰기');
  await waitFor(window, () => document.querySelector('.grid')?.textContent.includes('notes/sample-1.md'));
  assert((await getText(window, '.grid')).includes('notes/sample-1.md'), 'Sample note write did not update status');

  await clickButton(window, 'Sync');
  assert((await getText(window, 'h2')).includes('같은 Wi-Fi'), 'Sync tab did not activate');
  await clickButton(window, '수신 세션 열기');
  await waitFor(window, () => document.querySelector('.grid')?.textContent.includes('http://127.0.0.1:49152/sync/qa-session'));
  assert((await getText(window, '.grid')).includes('http://127.0.0.1:49152/sync/qa-session'), 'Sync session URL is missing');
  await clickButton(window, '미리보기 적용');
  await waitFor(window, () => document.querySelector('.grid')?.textContent.includes('mobile-preview-'));
  assert((await getText(window, '.grid')).includes('mobile-preview-'), 'Preview transaction result is missing');
  await clickButton(window, 'JSON 가져오기');
  await waitFor(window, () => document.querySelector('.grid')?.textContent.includes('import-transaction'));
  assert((await getText(window, '.grid')).includes('import-transaction'), 'Import transaction result is missing');
  await clickButton(window, '세션 닫기');
  await waitFor(window, () => !document.querySelector('.grid')?.textContent.includes('http://127.0.0.1:49152/sync/qa-session'));
  assert(!(await getText(window, '.grid')).includes('http://127.0.0.1:49152/sync/qa-session'), 'Sync session did not close');

  await clickButton(window, 'Settings');
  assert((await getText(window, 'h2')).includes('데스크탑 연결 상태'), 'Settings tab did not activate');
  assert((await getText(window, '.grid')).includes('Vault → 연결됨'), 'Settings status does not show vault state');

  window.close();
  console.log('desktop renderer UI ok');
}

run()
  .then(() => {
    try { fs.rmSync(preloadPath, { force: true }); } catch (_) {}
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    try { fs.rmSync(preloadPath, { force: true }); } catch (_) {}
    app.exit(1);
  });
