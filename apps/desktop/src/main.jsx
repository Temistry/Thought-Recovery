import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createSyncTransaction, createVaultManifest, getVaultMarkdownPath } from '@thought-recovery/core';
import './styles.css';

const sampleVaultNote = {
  id: 'desktop-sample-note',
  type: 'note',
};

function App() {
  const [syncSession, setSyncSession] = useState(null);
  const [vaultOverview, setVaultOverview] = useState(null);
  const [statusMessage, setStatusMessage] = useState('Vault를 만들거나 기존 폴더를 선택하면 파일 I/O 상태를 확인합니다.');
  const previewManifest = useMemo(() => createVaultManifest('local-desktop-vault', new Date().toISOString()), []);
  const samplePath = getVaultMarkdownPath(sampleVaultNote);
  const previewTransaction = useMemo(() => createSyncTransaction({
    transactionId: 'preview-transaction',
    sourceDeviceId: 'desktop-preview',
    now: previewManifest.createdAt,
    files: [{ path: samplePath, content: 'preview' }],
  }), [previewManifest.createdAt, samplePath]);

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
    setStatusMessage(`${overview.lastWrittenPath} 파일을 썼습니다.`);
  }

  async function startLocalSyncSession() {
    if (!desktopApi) {
      setSyncSession({ sessionId: 'dev-preview-session', expiresAt: Date.now() + 5 * 60 * 1000, deviceName: 'preview' });
      return;
    }
    setSyncSession(await desktopApi.createSyncSession());
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brandMark">생</div>
        <div>
          <p className="eyebrow">Thought Recovery</p>
          <h1>생각회수기 Desktop</h1>
        </div>
        <nav>
          <button className="navButton active">Vault</button>
          <button className="navButton">Search</button>
          <button className="navButton">Sync</button>
          <button className="navButton">Settings</button>
        </nav>
      </aside>

      <section className="content">
        <header className="hero">
          <p className="eyebrow">Windows portable first</p>
          <h2>모바일에서 회수한 생각을 PC에서 안전하게 다시 엽니다</h2>
          <p>Markdown, audio, attachment 중심 Vault를 만들고, 로컬 파일 I/O와 검증 가능한 sync transaction을 먼저 단단하게 붙이는 단계입니다.</p>
        </header>

        <div className="grid">
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

          <article className="card syncCard">
            <p className="cardKicker">Local sync</p>
            <h3>5분짜리 로컬 연결 세션</h3>
            <p>중앙 서버 없이 같은 네트워크 안에서 모바일이 데스크탑 세션에 접속하는 구조의 첫 뼈대입니다.</p>
            <button className="primaryButton" onClick={startLocalSyncSession}>동기화 세션 열기</button>
            {syncSession ? (
              <div className="sessionBox">
                <strong>{syncSession.sessionId}</strong>
                <span>{syncSession.deviceName} · {new Date(syncSession.expiresAt).toLocaleTimeString()} 만료</span>
              </div>
            ) : null}
          </article>

          <article className="card">
            <p className="cardKicker">Transaction preview</p>
            <h3>검증 가능한 변경 묶음</h3>
            <ul>
              <li>transaction → {previewTransaction.transactionId}</li>
              <li>files → {previewTransaction.files.length}</li>
              <li>hash/bytes 검증 포함</li>
            </ul>
          </article>

          <article className="card">
            <p className="cardKicker">AI settings</p>
            <h3>API key는 기기별 보관</h3>
            <p>OpenAI/Anthropic 중 하나를 선택하되 key는 동기화하지 않습니다. AI 결과물만 데이터로 취급해 Vault와 동기화합니다.</p>
          </article>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
