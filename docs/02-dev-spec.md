# 개발명세

## 기술 스택
- Expo React Native + TypeScript
- iOS/Android/Web 동시 실행
- Supabase Auth + PostgreSQL + Realtime
- 추후 pgvector 기반 의미 검색
- 추후 OpenAI/Whisper 또는 Gemini 기반 음성 전사/요약

## 실행 모드
### Local Demo Mode
`.env`에 Supabase 키가 없으면 AsyncStorage 기반 로컬 메모장으로 실행된다. 바로 앱 UX를 확인하기 위한 모드다.

### Cloud Sync Mode
`.env`에 Supabase 키를 넣으면 Supabase 로그인/동기화 모드로 실행된다. 로그인은 비밀번호 없는 이메일 OTP 코드 방식이다.

## 환경 변수
`.env.example`을 복사해 `.env` 생성:

```bash
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

## MVP 화면
- 로그인/이메일 인증 코드 요청 및 확인
- 메모 입력
- 음성 녹음 버튼(현재는 녹음 URI 기반 원본 보존용 시작점)
- 메모 목록
- AI 제목/요약 필드 표시 영역
- 동기화 상태 표시

## 데이터 저장 원칙
- `raw_text`: 사용자가 직접 입력하거나 음성에서 전사된 원본
- `ai_title`, `ai_summary`, `ai_tags`: AI가 만든 파생 데이터
- `source_type`: text 또는 voice
- `audio_url`: 음성 원본 URL 또는 로컬 URI
- `note_links`: 메모 간 연결 이유와 confidence 저장
- `note_versions`: AI 유지보수/편집 이력 저장

## 다음 개발 단계
1. Supabase 프로젝트 생성 및 schema.sql 적용
2. Email OTP 인증 테스트
3. 음성 파일 Supabase Storage 업로드
4. STT Edge Function 추가
5. AI 요약/태그/관련 메모 추천 Edge Function 추가
6. pgvector 의미 검색 추가
7. 그래프 뷰 추가
