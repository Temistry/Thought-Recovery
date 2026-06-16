# Idea Second Brain

말하거나 짧게 적으면 아이디어를 정리·연결·구체화하는 AI 세컨드브레인 앱 MVP입니다.

## 현재 구현된 것
- Expo 기반 iOS/Android/Web 공통 앱
- Supabase 설정 전에도 동작하는 로컬 데모 모드
- Supabase 설정 후 이메일+비밀번호 로그인 + 메모 동기화
- 첫 로그인 시 로컬 메모를 클라우드로 1회 복사
- 텍스트 메모 저장
- 음성 메모 녹음 시작점
- Supabase Storage 업로드 + Edge Function 전사 호출 코드
- AI 제목/요약 필드 구조
- 개발명세/DB 스키마 문서

## 실행
```bash
cd C:\Users\kal91\.openclaw\workspace\idea-second-brain
npm start
```

웹에서 바로 보기:
```bash
npm run web
```

갤럭시 S10e/iPhone 13에서 보기:
1. 휴대폰에 Expo Go 설치
2. PC와 같은 Wi-Fi 연결
3. `npm start` 실행
4. QR 코드 스캔

## Supabase 동기화 켜기
1. Supabase 프로젝트 생성
2. Supabase Auth에서 Email provider 활성화 확인
3. 개발 테스트 중에는 Authentication > Sign In / Providers에서 `Confirm email` 끄기
4. `supabase/schema.sql`을 SQL Editor에서 실행
5. `.env.example`을 `.env`로 복사
6. Supabase Project URL / publishable key 입력
7. 앱 재시작
8. 앱에서 이메일+비밀번호로 계정 생성/로그인

```bash
copy .env.example .env
```

## 문서
- `docs/01-product-spec.md`: 제품 기획명세
- `docs/02-dev-spec.md`: 개발명세
- `supabase/schema.sql`: DB/RLS 스키마

## 음성 전사 세팅

앱에는 OpenAI 키를 넣지 않습니다. Supabase Edge Function secret으로만 설정합니다.

1. `supabase/schema.sql`을 Supabase SQL Editor에서 다시 실행해 `note-audio` Storage bucket/policy를 추가합니다.
2. Supabase Edge Function `transcribe-note`를 배포합니다.
3. Supabase Function Secret에 `OPENAI_API_KEY`를 설정합니다.
4. Expo 앱에서 음성 메모를 녹음하면 Storage 업로드 → `gpt-4o-mini-transcribe` 전사 → `notes.raw_text` 업데이트 흐름으로 처리됩니다.

## 다음 작업
- Supabase Edge Function 실제 배포
- OPENAI_API_KEY를 Supabase secret으로 설정
- 아이폰 음성 전사 smoke test
- AI 요약/태그/연결 추천 Edge Function
- pgvector 의미 검색
- 관련 메모/그래프 뷰
