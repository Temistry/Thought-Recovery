# 생각회수기 / Thought Recovery

> 말해두면 생각이 사라지지 않고, 다시 읽을 수 있는 기획 리포트로 자라나는 오픈소스 AI 메모 앱입니다.

생각회수기는 짧은 음성 메모나 텍스트 메모를 남기면 AI가 원문을 보존하고, 제목·요약·태그·관련 생각·자라난 생각 리포트로 정리해 주는 로컬-first 세컨드브레인 앱입니다.

단순히 “메모를 많이 저장하는 앱”이 아니라, 사용자가 잊어버린 말과 생각을 다시 회수해서 기획·판단·실행으로 이어가게 만드는 것을 목표로 합니다.

## 오픈소스 안내

이 프로젝트는 **오픈소스 프로젝트**입니다.

- 라이선스: [MIT License](./LICENSE)
- 누구나 코드를 읽고, 수정하고, 포크하고, 개인/상업 프로젝트에 참고할 수 있습니다.
- 단, 사용자가 직접 입력한 API key, Supabase 설정값, 개인 메모 데이터는 각자의 책임으로 안전하게 관리해야 합니다.
- 이 저장소에는 실제 API key나 개인 데이터가 포함되어서는 안 됩니다.

## 이 앱은 무엇을 하나요?

### 1. 빠르게 생각을 남깁니다

- 음성으로 말하거나 텍스트로 짧게 적습니다.
- 완성된 글을 쓰지 않아도 됩니다.
- 떠오른 생각, 할 일, 제품 아이디어, 회의 후 감상, 소설/게임 기획 조각처럼 정리되지 않은 말도 저장할 수 있습니다.

### 2. 원문을 보존합니다

- AI가 요약하더라도 원본 메모는 사라지지 않습니다.
- 원본은 나중에 다시 확인할 수 있는 근거로 남습니다.
- 로컬 저장과 Vault 구조를 통해 “내 생각을 내가 소유한다”는 방향을 우선합니다.

### 3. AI가 생각을 정리합니다

앱은 메모를 바탕으로 다음 정보를 만들 수 있습니다.

- AI 제목
- AI 요약
- 태그
- 관련 메모 연결
- 반복되는 주제
- 할 일 후보
- 자라난 생각 리포트

### 4. 여러 메모를 묶어 리포트로 만듭니다

`자라난 생각`은 사용자의 입장을 멋대로 단정하는 1인칭 글이 아닙니다.

여러 원문을 분류하고 묶어서 다음 형태로 정리하는 리포트입니다.

- 핵심 요약
- 반복해서 나온 주제
- 생각의 흐름
- 근거가 된 원문
- 다음에 이어볼 질문

목표는 사용자가 “아, 내가 이런 생각들을 하고 있었구나”라고 느끼게 만드는 것입니다.

## 주요 기능

### 모바일 앱

- Expo React Native 기반 iOS/Android/Web 앱
- 음성 메모 녹음
- 텍스트 메모 저장
- 로컬 SQLite/AsyncStorage 기반 저장
- Supabase 기반 클라우드 로그인/동기화 준비
- 사용자 보유 API key 기반 AI 기능 잠금/해제 UX
- 오늘 남긴 생각, 생각 리포트, 보관, 할 일 탭
- 메모 상세, 원문 수정, 관련 생각 연결
- 데스크탑 동기화 package 생성 및 전송

### 데스크탑 앱

- Electron + React + Vite 기반 Windows-first 데스크탑 앱
- 로컬 Vault 폴더 생성/선택
- Markdown 기반 notes/reports 저장
- `attachments/audio` 구조 준비
- 모바일에서 보낸 sync transaction package 검증/적용
- 5분짜리 로컬 HTTP 수신 세션
- 수신 URL 복사
- QR 표시
- QR을 iPhone 기본 카메라로 열었을 때 안내 페이지 표시
- `updatedAt` 기반 충돌 skip 정책

### 로컬 동기화

모바일과 데스크탑은 중앙 서버 없이 같은 Wi‑Fi 안에서 데이터를 주고받을 수 있습니다.

기본 흐름은 다음과 같습니다.

1. 데스크탑 앱에서 Vault 폴더를 만듭니다.
2. 데스크탑에서 `수신 세션 열기`를 누릅니다.
3. 5분 동안 유효한 로컬 수신 URL과 QR이 표시됩니다.
4. 모바일 앱 설정 → 데이터에서 URL을 붙여넣습니다.
5. `보내기`를 누르면 모바일 메모/리포트가 sync package로 전송됩니다.
6. 데스크탑은 hash, byte size, path를 검증한 뒤 Vault에 저장합니다.
7. 기존 파일이 더 최신이면 덮어쓰지 않고 skip합니다.

## 저장 구조

데스크탑 Vault는 사용자가 직접 열어볼 수 있는 파일 구조를 지향합니다.

```text
Thought Recovery Vault/
  manifest.json
  notes/
    <note-id>.md
  reports/
    <report-id>.md
  attachments/
    audio/
      <audio-id>.m4a
```

Markdown 파일은 frontmatter를 포함합니다.

```md
---
id: example-note
type: note
createdAt: 2026-06-28T00:00:00.000Z
updatedAt: 2026-06-28T00:10:00.000Z
deletedAt: null
title: "예시 메모"
summary: "짧은 요약"
tags:
  - idea
  - planning
audioIds:
---

메모 원문이 여기에 저장됩니다.
```

## 어떻게 사용하나요?

### 1. 저장소 받기

```bash
git clone <repository-url>
cd idea-second-brain
npm install
```

### 2. 모바일 앱 실행

```bash
npm start
```

Expo가 실행되면 다음 중 하나로 확인합니다.

- iPhone/Android: Expo Go로 QR 스캔
- iOS simulator: `npm run ios`
- Android emulator: `npm run android`
- Web preview: `npm run web`

개발 중 기본 터널 실행이 필요하면 다음처럼 실행할 수 있습니다.

```bash
npx expo start --tunnel --clear
```

### 3. 데스크탑 앱 빌드

```bash
npm run build --workspace @idea-second-brain/desktop
```

portable zip 생성:

```bash
npm run dist:zip --workspace @idea-second-brain/desktop
```

산출물 위치:

```text
apps/desktop/release/thought-recovery-desktop-win-portable.zip
```

### 4. 모바일 → 데스크탑 동기화 사용법

1. 데스크탑 앱을 엽니다.
2. `기본 Vault 만들기` 또는 `폴더 선택`을 누릅니다.
3. `수신 세션 열기`를 누릅니다.
4. 데스크탑에 표시된 URL을 복사하거나 QR을 iPhone 기본 카메라로 스캔합니다.
5. 모바일 앱에서 설정/계정 → 데이터로 이동합니다.
6. 데스크탑 수신 URL 입력칸에 URL을 붙여넣습니다.
7. `보내기`를 누릅니다.
8. 데스크탑 Vault의 `notes/`, `reports/`에 Markdown 파일이 생성됩니다.

주의:

- iPhone과 Windows PC가 같은 Wi‑Fi에 있어야 합니다.
- Windows Defender Firewall이 뜨면 private network 접근을 허용해야 합니다.
- 수신 URL은 5분 후 만료됩니다.
- 전송 실패 시 데스크탑에서 세션을 다시 열고 재시도하세요.

## AI/API key 사용 방식

생각회수기는 사용자의 API key를 앱 서버에 맡기지 않는 방향을 지향합니다.

현재 방향:

- 모바일 앱에서 OpenAI 또는 Anthropic 중 하나를 선택합니다.
- API key는 기기 로컬에만 저장합니다.
- API key는 동기화하지 않습니다.
- API key가 없으면 녹음/AI 전사/AI 정리/리포트 생성 기능은 잠김 상태로 표시됩니다.
- 이미 생성된 AI 결과물은 데이터로 취급되어 Vault 동기화 대상이 될 수 있습니다.

## Supabase 설정

Supabase 없이도 로컬 모드로 앱을 확인할 수 있습니다.

클라우드 로그인/동기화를 켜려면:

1. Supabase 프로젝트를 생성합니다.
2. Supabase Auth에서 Email provider를 활성화합니다.
3. 개발 테스트 중에는 필요에 따라 email confirm을 끌 수 있습니다.
4. `supabase/schema.sql`을 SQL Editor에서 실행합니다.
5. `.env.example`을 `.env`로 복사합니다.
6. Supabase Project URL / anon key를 입력합니다.
7. 앱을 재시작합니다.

```bash
copy .env.example .env
```

`.env` 예시:

```env
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
```

실제 secret/service role key는 클라이언트 앱에 넣지 마세요.

## 개발 명령어

```bash
# TypeScript 검사
npx tsc --noEmit

# 모바일 Expo 실행
npm start

# Web 실행
npm run web

# 데스크탑 빌드
npm run build --workspace @idea-second-brain/desktop

# 데스크탑 portable zip 생성
npm run dist:zip --workspace @idea-second-brain/desktop

# 데스크탑 sync 충돌 정책 테스트
node apps/desktop/scripts/test-sync-conflict.cjs

# 데스크탑 local HTTP sync roundtrip 테스트
node apps/desktop/scripts/test-local-http-sync.cjs

# iOS export smoke test
npx expo export --platform ios --output-dir .expo-ios-test
```

## 프로젝트 구조

```text
.
├─ App.tsx                         # 모바일 앱 중심 UI
├─ src/                            # 모바일 로컬 저장/Supabase 보조 코드
├─ packages/core/                  # 모바일/데스크탑 공통 타입, Vault, sync 로직
├─ apps/desktop/                   # Electron 데스크탑 앱
├─ supabase/                       # DB schema / Edge Function 관련 파일
├─ docs/                           # 제품/개발 문서
├─ samples/                        # 샘플 데이터
└─ locales/                        # 다국어 리소스 준비 영역
```

## 현재 MVP 상태

완료된 축:

- 모바일 메모/리포트 → sync package export
- 데스크탑 Vault 생성/선택
- 데스크탑 local HTTP receiver
- QR/URL 기반 모바일→데스크탑 전송
- Markdown Vault 저장
- hash/size/path 검증
- `updatedAt` 기반 충돌 skip
- 기본 자동 테스트

운영 확인이 필요한 축:

- 실제 iPhone + Windows 같은 Wi‑Fi 전송 QA
- Windows Defender Firewall 허용 흐름
- 다량 메모 전송 시 12MB 제한 적정성
- 장기적으로 in-app QR scanner 도입 여부

## 기여하기

이 프로젝트는 오픈소스입니다. 다음 방식의 기여를 환영합니다.

- 버그 리포트
- README/문서 개선
- 모바일 UX 개선
- 데스크탑 Vault/sync 안정성 개선
- AI 요약/리포트 품질 개선
- i18n 번역
- 테스트 추가

기여 시 주의:

- 실제 API key, `.env`, 개인 메모, 로컬 Vault 파일을 커밋하지 마세요.
- 사용자 데이터 소유권과 로컬-first 방향을 해치지 않는 변경을 우선합니다.
- 기능을 늘리기보다 “빠르게 말하고, 나중에 다시 회수한다”는 핵심 루프를 보호합니다.

## 라이선스

MIT License. 자세한 내용은 [LICENSE](./LICENSE)를 확인하세요.
