import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import { createSyncTransactionPackage, createVaultManifest, getVaultMarkdownPath } from '@thought-recovery/core';
import './styles.css';

const sampleVaultNote = {
  id: 'desktop-sample-note',
  type: 'note',
};

const desktopTabs = [
  {
    id: 'vault',
    label: 'Vault',
    eyebrow: 'Windows portable first',
    title: '모바일에서 회수한 생각을 PC에서 안전하게 다시 엽니다',
    description: '모바일이 보낼 변경 묶음을 데스크탑이 로컬 HTTP 세션으로 받고, 검증 후 Vault에 적용하는 최소 경로입니다.',
  },
  {
    id: 'search',
    label: 'Search',
    eyebrow: 'Vault search',
    title: 'PC에 저장된 생각을 빠르게 찾아봅니다',
    description: '현재 연결된 Vault 상태를 기준으로 메모와 리포트 검색 화면을 준비합니다.',
  },
  {
    id: 'sync',
    label: 'Sync',
    eyebrow: 'Local HTTP sync',
    title: '같은 Wi-Fi에서 모바일 메모를 받아옵니다',
    description: '5분 동안 열리는 로컬 수신 URL로 모바일의 변경 묶음을 안전하게 적용합니다.',
  },
  {
    id: 'settings',
    label: 'Settings',
    eyebrow: 'Desktop settings',
    title: '데스크탑 연결 상태를 확인합니다',
    description: 'Vault 경로, 동기화 세션, 최근 작업 상태를 한 곳에서 확인합니다.',
  },
];

function App() {
  const [activeTab, setActiveTab] = useState('vault');
  const [syncSession, setSyncSession] = useState(null);
  const [syncQrDataUrl, setSyncQrDataUrl] = useState(null);
  const [vaultOverview, setVaultOverview] = useState(null);
  const [lastApplyResult, setLastApplyResult] = useState(null);
  const [statusMessage, setStatusMessage] = useState('Vault를 만들거나 기존 폴더를 선택하면 파일 I/O 상태를 확인합니다.');
  const previewManifest = useMemo(() => createVaultManifest('local-desktop-vault', new Date().toISOString()), []);
  const samplePath = getVaultMarkdownPath(sampleVaultNote);
  const previewPackage = useMemo(() => createSyncTransactionPackage({
    transactionId: 'preview-transaction',
    sourceDeviceId: 'mobile-preview',
    now: previewManifest.createdAt,
    files: [{ path: samplePath, content: 'preview' }],
  }), [previewManifest.createdAt, samplePath]);
  const activeTabContent = desktopTabs.find((tab) => tab.id === activeTab) ?? desktopTabs[0];

  const desktopApi = window.thoughtRecoveryDesktop;

  async function createDefaultVault() {
    if (!desktopApi) {
      setStatusMessage('브라우저 미리보기에서는 실제 폴더를 만들 수 없습니다. Electron 앱에서 확인하세요.');
      return;
    }
    const overview = await desktopApi.createDefaultVault();
    setVaultOverview(overview);
    setStatusMessage('문서 폴더에 기본 Vault 구조를 만들었습니다.');
  }

  async function selectVaultDirectory() {
    if (!desktopApi) {
      setStatusMessage('브라우저 미리보기에서는 폴더 선택을 사용할 수 없습니다. Electron 앱에서 확인하세요.');
      return;
    }
    const overview = await desktopApi.selectVaultDirectory();
    if (!overview) {
      setStatusMessage('Vault 폴더 선택을 취소했습니다.');
      return;
    }
    setVaultOverview(overview);
    setStatusMessage('선택한 폴더를 Vault 구조로 확인했습니다.');
  }

  async function writeSampleNote() {
    if (!desktopApi || !vaultOverview?.vaultPath) return;
    const overview = await desktopApi.writeSampleNote(vaultOverview.vaultPath);
    setVaultOverview(overview);
    setLastApplyResult({ transactionId: 'desktop-sample', applied: { upserts: [overview.lastWrittenPath], deletes: [] } });
    setStatusMessage(`${overview.lastWrittenPath} 파일을 썼습니다.`);
  }

  async function applyPreviewMobileTransaction() {
    if (!desktopApi || !vaultOverview?.vaultPath) {
      setStatusMessage('먼저 Vault를 만들거나 선택해야 합니다.');
      return;
    }
    const now = new Date().toISOString();
    const noteId = `mobile-preview-${Date.now().toString(36)}`;
    const notePath = `notes/${noteId}.md`;
    const markdown = [
      '---',
      `id: ${noteId}`,
      'type: note',
      `createdAt: ${now}`,
      `updatedAt: ${now}`,
      'deletedAt: null',
      'title: "모바일에서 넘어온 미리보기 메모"',
      'summary: "sync transaction 적용 확인용"',
      'tags:',
      '  - mobile',
      '  - sync',
      'audioIds:',
      '---',
      '',
      '이 파일은 모바일 export가 보낼 transaction package와 같은 형태로 데스크탑 Vault에 적용된 미리보기 메모입니다.',
      '',
    ].join('\n');
    const syncPackage = createSyncTransactionPackage({
      transactionId: `mobile-preview-${Date.now().toString(36)}`,
      sourceDeviceId: 'mobile-preview',
      now,
      files: [{ path: notePath, content: markdown }],
    });
    const result = await desktopApi.applySyncTransactionPackage(vaultOverview.vaultPath, syncPackage);
    setVaultOverview(result.overview);
    setLastApplyResult(result);
    setStatusMessage(`${result.applied.upserts.length}개 파일을 transaction으로 적용했습니다.`);
  }

  async function importSyncTransactionPackage() {
    if (!desktopApi || !vaultOverview?.vaultPath) {
      setStatusMessage('먼저 Vault를 만들거나 선택해야 합니다.');
      return;
    }
    const result = await desktopApi.importSyncTransactionPackage(vaultOverview.vaultPath);
    if (!result) {
      setStatusMessage('transaction JSON 가져오기를 취소했습니다.');
      return;
    }
    setVaultOverview(result.overview);
    setLastApplyResult(result);
    setStatusMessage(`${result.transactionId} transaction을 적용했습니다.`);
  }

  async function startLocalSyncSession() {
    if (!desktopApi) {
      setSyncSession({ sessionId: 'dev-preview-session', url: 'http://127.0.0.1:0/sync/dev-preview-session', expiresAt: Date.now() + 5 * 60 * 1000, deviceName: 'preview' });
      return;
    }
    if (!vaultOverview?.vaultPath) {
      setStatusMessage('먼저 Vault를 만들거나 선택해야 합니다.');
      return;
    }
    const session = await desktopApi.createSyncSession(vaultOverview.vaultPath);
    setSyncSession(session);
    setSyncQrDataUrl(await QRCode.toDataURL(session.url, { margin: 1, width: 220 }));
    setStatusMessage('모바일에서 이 URL로 동기화 패키지를 보낼 수 있습니다.');
  }

  async function stopLocalSyncSession() {
    if (desktopApi?.stopSyncSession) await desktopApi.stopSyncSession();
    setSyncSession(null);
    setSyncQrDataUrl(null);
    setStatusMessage('동기화 세션을 닫았습니다.');
  }

  async function copySyncUrl() {
    if (!syncSession?.url) return;
    await copyText(syncSession.url);
    setStatusMessage('수신 URL을 클립보드에 복사했습니다. 모바일 설정에 붙여넣어 보내면 됩니다.');
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brandMark">생</div>
        <div>
          <p className="eyebrow">Thought Recovery</p>
          <h1>생각회수기 Desktop</h1>
        </div>
        <nav aria-label="Desktop sections">
          {desktopTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`navButton ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={activeTab === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="content">
        <header className="hero">
          <p className="eyebrow">{activeTabContent.eyebrow}</p>
          <h2>{activeTabContent.title}</h2>
          <p>{activeTabContent.description}</p>
        </header>

        <div className="grid">
          {activeTab === 'vault' ? (
            <>
              <VaultCard
                previewManifest={previewManifest}
                samplePath={samplePath}
                statusMessage={statusMessage}
                vaultOverview={vaultOverview}
                createDefaultVault={createDefaultVault}
                selectVaultDirectory={selectVaultDirectory}
                writeSampleNote={writeSampleNote}
              />
              <TransactionPreviewCard previewPackage={previewPackage} />
            </>
          ) : null}

          {activeTab === 'search' ? (
            <>
              <SearchCard vaultOverview={vaultOverview} selectVaultDirectory={selectVaultDirectory} />
              <StatusCard statusMessage={statusMessage} syncSession={syncSession} vaultOverview={vaultOverview} />
            </>
          ) : null}

          {activeTab === 'sync' ? (
            <>
              <SyncCard
                syncSession={syncSession}
                syncQrDataUrl={syncQrDataUrl}
                startLocalSyncSession={startLocalSyncSession}
                stopLocalSyncSession={stopLocalSyncSession}
                copySyncUrl={copySyncUrl}
              />
              <TransactionApplyCard
                lastApplyResult={lastApplyResult}
                applyPreviewMobileTransaction={applyPreviewMobileTransaction}
                importSyncTransactionPackage={importSyncTransactionPackage}
              />
            </>
          ) : null}

          {activeTab === 'settings' ? (
            <>
              <StatusCard statusMessage={statusMessage} syncSession={syncSession} vaultOverview={vaultOverview} />
              <VaultCard
                previewManifest={previewManifest}
                samplePath={samplePath}
                statusMessage={statusMessage}
                vaultOverview={vaultOverview}
                createDefaultVault={createDefaultVault}
                selectVaultDirectory={selectVaultDirectory}
                writeSampleNote={writeSampleNote}
              />
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function VaultCard({ previewManifest, samplePath, statusMessage, vaultOverview, createDefaultVault, selectVaultDirectory, writeSampleNote }) {
  return (
    <article className="card">
      <p className="cardKicker">Vault file I/O</p>
      <h3>{vaultOverview ? 'Vault 연결됨' : 'Vault 준비'}</h3>
      {vaultOverview ? (
        <div className="vaultInfo">
          <span>{vaultOverview.vaultPath}</span>
          <strong>{vaultOverview.counts.notes} notes · {vaultOverview.counts.reports} reports · {vaultOverview.counts.audio} audio</strong>
        </div>
      ) : (
        <ul>
          <li>notes → {samplePath}</li>
          <li>reports → reports/&lt;stable-id&gt;.md</li>
          <li>audio → {previewManifest.audioPath}/&lt;audio-id&gt;.m4a</li>
        </ul>
      )}
      <div className="buttonRow">
        <button className="primaryButton" onClick={createDefaultVault}>기본 Vault 만들기</button>
        <button className="secondaryButton" onClick={selectVaultDirectory}>폴더 선택</button>
      </div>
      {vaultOverview ? <button className="secondaryButton wide" onClick={writeSampleNote}>샘플 메모 쓰기</button> : null}
      <p className="statusText">{statusMessage}</p>
    </article>
  );
}

function SyncCard({ syncSession, syncQrDataUrl, startLocalSyncSession, stopLocalSyncSession, copySyncUrl }) {
  return (
    <article className="card syncCard">
      <p className="cardKicker">Local HTTP sync</p>
      <h3>5분짜리 수신 URL</h3>
      <p>같은 Wi-Fi에서 모바일이 이 URL로 package를 보내면 데스크탑 Vault에 바로 적용합니다.</p>
      <div className="buttonRow">
        <button className="primaryButton" onClick={startLocalSyncSession}>수신 세션 열기</button>
        {syncSession ? <button className="secondaryButton" onClick={stopLocalSyncSession}>세션 닫기</button> : null}
      </div>
      {syncSession ? (
        <div className="sessionBox">
          {syncQrDataUrl ? <img className="qrImage" src={syncQrDataUrl} alt="동기화 수신 URL QR" /> : null}
          <strong>{syncSession.url}</strong>
          <span>{syncSession.deviceName} · {new Date(syncSession.expiresAt).toLocaleTimeString()} 만료</span>
          <button className="copyButton" onClick={copySyncUrl}>URL 복사</button>
        </div>
      ) : null}
    </article>
  );
}

function TransactionApplyCard({ lastApplyResult, applyPreviewMobileTransaction, importSyncTransactionPackage }) {
  return (
    <article className="card">
      <p className="cardKicker">Transaction apply</p>
      <h3>수동 적용/가져오기</h3>
      <p>네트워크 연결 전에도 JSON 파일이나 미리보기 package로 같은 적용 경로를 검증할 수 있습니다.</p>
      <div className="buttonRow">
        <button className="primaryButton" onClick={applyPreviewMobileTransaction}>미리보기 적용</button>
        <button className="secondaryButton" onClick={importSyncTransactionPackage}>JSON 가져오기</button>
      </div>
      {lastApplyResult ? (
        <div className="sessionBox">
          <strong>{lastApplyResult.transactionId}</strong>
          <span>{lastApplyResult.applied.upserts.length} upsert · {lastApplyResult.applied.deletes.length} delete · {(lastApplyResult.applied.skipped?.length ?? 0)} skipped</span>
        </div>
      ) : null}
    </article>
  );
}

function TransactionPreviewCard({ previewPackage }) {
  return (
    <article className="card">
      <p className="cardKicker">Transaction preview</p>
      <h3>검증 가능한 변경 묶음</h3>
      <ul>
        <li>transaction → {previewPackage.transaction.transactionId}</li>
        <li>files → {previewPackage.transaction.files.length}</li>
        <li>hash/bytes 검증 포함</li>
      </ul>
    </article>
  );
}

function SearchCard({ vaultOverview, selectVaultDirectory }) {
  return (
    <article className="card">
      <p className="cardKicker">Vault search</p>
      <h3>{vaultOverview ? '검색 준비됨' : 'Vault가 필요합니다'}</h3>
      {vaultOverview ? (
        <div className="vaultInfo">
          <span>{vaultOverview.vaultPath}</span>
          <strong>{vaultOverview.counts.notes + vaultOverview.counts.reports} searchable files</strong>
        </div>
      ) : (
        <p>검색하려면 먼저 Vault 폴더를 선택하세요.</p>
      )}
      <div className="buttonRow">
        <button className="secondaryButton" onClick={selectVaultDirectory}>Vault 선택</button>
      </div>
    </article>
  );
}

function StatusCard({ statusMessage, syncSession, vaultOverview }) {
  return (
    <article className="card">
      <p className="cardKicker">Current status</p>
      <h3>현재 상태</h3>
      <ul>
        <li>Vault → {vaultOverview ? '연결됨' : '미연결'}</li>
        <li>Sync → {syncSession ? '수신 세션 열림' : '대기 중'}</li>
        <li>Status → {statusMessage}</li>
      </ul>
    </article>
  );
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

createRoot(document.getElementById('root')).render(<App />);
