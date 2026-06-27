import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createVaultManifest, getVaultMarkdownPath } from '@thought-recovery/core';
import './styles.css';

const sampleVaultNote = {
  id: 'desktop-sample-note',
  type: 'note',
};

function App() {
  const [syncSession, setSyncSession] = useState(null);
  const manifest = useMemo(() => createVaultManifest('local-desktop-vault', new Date().toISOString()), []);
  const samplePath = getVaultMarkdownPath(sampleVaultNote);

  async function startLocalSyncSession() {
    const api = window.thoughtRecoveryDesktop;
    if (!api) {
      setSyncSession({ sessionId: 'dev-preview-session', expiresAt: Date.now() + 5 * 60 * 1000 });
      return;
    }
    setSyncSession(await api.createSyncSession());
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
          <h2>모바일에서 회수한 생각을 PC에서 다시 씁니다</h2>
          <p>Markdown/audio/attachments 중심 Vault를 읽고, 숨은 SQLite 캐시로 검색과 정리를 빠르게 만드는 데스크탑 뼈대입니다.</p>
        </header>

        <div className="grid">
          <article className="card">
            <p className="cardKicker">Vault structure</p>
            <h3>{manifest.vaultId}</h3>
            <ul>
              <li>notes → {samplePath}</li>
              <li>reports → reports/&lt;stable-id&gt;.md</li>
              <li>audio → {manifest.audioPath}/&lt;audio-id&gt;.m4a</li>
            </ul>
          </article>

          <article className="card syncCard">
            <p className="cardKicker">Local sync</p>
            <h3>QR/session 기반 5분 연결</h3>
            <p>중앙 서버 없이 같은 네트워크에서 모바일이 데스크탑 세션에 접속하는 흐름입니다.</p>
            <button className="primaryButton" onClick={startLocalSyncSession}>동기화 세션 열기</button>
            {syncSession ? (
              <div className="sessionBox">
                <strong>{syncSession.sessionId}</strong>
                <span>{new Date(syncSession.expiresAt).toLocaleTimeString()} 만료</span>
              </div>
            ) : null}
          </article>

          <article className="card">
            <p className="cardKicker">AI settings</p>
            <h3>API key는 기기별 보관</h3>
            <p>OpenAI/Anthropic 중 하나만 활성화하고, key는 동기화하지 않는 정책으로 UI와 저장소를 분리합니다.</p>
          </article>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
