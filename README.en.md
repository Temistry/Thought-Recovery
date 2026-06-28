# Thought Recovery

English | [한국어](./README.md)

> An open-source second brain app that turns voice notes into organized thoughts and stores them in a local Vault you can revisit anytime.

Thought Recovery is a local-first AI note app. You can capture short voice notes or text notes, preserve the original source, and let AI organize them into titles, summaries, tags, related thoughts, and grown thought reports.

The goal is not to store more notes. The goal is to help you recover forgotten thoughts and turn them into planning, decisions, and action.

## Open source

This is an **open-source project**.

- License: [MIT License](./LICENSE)
- Repository: https://github.com/Temistry/Thought-Recovery
- You may read, modify, fork, and reuse the code for personal or commercial projects.
- You are responsible for safely managing your own API keys, Supabase settings, and personal note data.
- Real API keys and personal data must never be committed to this repository.

## What does this app do?

### 1. Capture thoughts quickly

- Speak into the app or write a short text note.
- You do not need to write polished documents.
- The app is designed for raw ideas, tasks, product thoughts, meeting reflections, fiction/game planning fragments, and unfinished thinking.

### 2. Preserve the original source

- AI can summarize your notes, but the original note remains available.
- The source text stays as evidence you can revisit later.
- The app prioritizes local storage and user-owned data through a Vault structure.

### 3. Organize thoughts with AI

The app can generate:

- AI title
- AI summary
- Tags
- Related note connections
- Repeated themes
- Action item candidates
- Grown thought reports

### 4. Turn multiple notes into reports

A `grown thought` report is not a first-person opinion piece that assumes what the user believes.

It groups and classifies multiple source notes into a structured report:

- Key summary
- Recurring themes
- Flow of thought
- Source evidence
- Follow-up questions

The intended feeling is: “Oh, these are the thoughts I have been circling around.”

## Key features

### Mobile app

- Expo React Native app for iOS, Android, and Web
- Voice note recording
- Text note saving
- Local SQLite/AsyncStorage storage
- Supabase-based cloud login/sync foundation
- User-owned API key UX for AI features
- Today, Thoughts, Archive, and Todo tabs
- Note detail, original text editing, and related thought linking
- Desktop sync package export and transfer

### Desktop app

- Windows-first desktop app built with Electron, React, and Vite
- Local Vault folder creation/selection
- Markdown-based notes/reports storage
- Prepared `attachments/audio` structure
- Validation and application of mobile sync transaction packages
- 5-minute local HTTP receiving session
- Receiver URL copy
- QR display
- Instruction page when opening the QR URL with the iPhone Camera app
- `updatedAt`-based conflict skip policy

### Local sync

Mobile and desktop can exchange data on the same Wi-Fi without a central server.

Basic flow:

1. Create a Vault folder in the desktop app.
2. Click `Open receive session` on desktop.
3. Desktop shows a local receive URL and QR that are valid for 5 minutes.
4. Paste the URL into mobile app settings → data.
5. Tap `Send`.
6. The mobile app sends notes/reports as a sync package.
7. Desktop validates hash, byte size, and path, then writes the files into the Vault.
8. If an existing file is newer, desktop skips the incoming older file instead of overwriting it.

## Storage structure

The desktop Vault is designed to be readable outside the app.

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

Markdown files include frontmatter.

```md
---
id: example-note
type: note
createdAt: 2026-06-28T00:00:00.000Z
updatedAt: 2026-06-28T00:10:00.000Z
deletedAt: null
title: "Example note"
summary: "Short summary"
tags:
  - idea
  - planning
audioIds:
---

The original note text is stored here.
```

## How to use

### 1. Clone the repository

```bash
git clone https://github.com/Temistry/Thought-Recovery.git
cd Thought-Recovery
npm install
```

### 2. Run the mobile app

```bash
npm start
```

Then open it with one of these options:

- iPhone/Android: scan the Expo QR with Expo Go
- iOS simulator: `npm run ios`
- Android emulator: `npm run android`
- Web preview: `npm run web`

For tunnel mode during development:

```bash
npx expo start --tunnel --clear
```

### 3. Build the desktop app

```bash
npm run build --workspace @idea-second-brain/desktop
```

Create a portable zip:

```bash
npm run dist:zip --workspace @idea-second-brain/desktop
```

Output path:

```text
apps/desktop/release/thought-recovery-desktop-win-portable.zip
```

### 4. Sync mobile to desktop

1. Open the desktop app.
2. Click `Create default Vault` or `Select folder`.
3. Click `Open receive session`.
4. Copy the URL shown on desktop, or scan the QR with the iPhone Camera app.
5. Open mobile app settings/account → data.
6. Paste the desktop receive URL.
7. Tap `Send`.
8. Markdown files appear in the desktop Vault under `notes/` and `reports/`.

Notes:

- iPhone and Windows PC must be on the same Wi-Fi.
- If Windows Defender Firewall appears, allow private network access.
- The receive URL expires after 5 minutes.
- If transfer fails, reopen a desktop receive session and retry.

## AI/API key model

Thought Recovery is designed to avoid storing user API keys on an app server.

Current direction:

- The mobile app lets the user choose OpenAI or Anthropic.
- API keys are stored only on the local device.
- API keys are not synced.
- Without an API key, recording, AI transcription, AI organization, and report generation appear locked.
- AI-generated results can be treated as data and synced into the Vault.

## Supabase setup

The app can be explored in local mode without Supabase.

To enable cloud login/sync:

1. Create a Supabase project.
2. Enable the Email provider in Supabase Auth.
3. For development, you may disable email confirmation if needed.
4. Run `supabase/schema.sql` in the SQL Editor.
5. Copy `.env.example` to `.env`.
6. Fill in Supabase Project URL and anon key.
7. Restart the app.

```bash
copy .env.example .env
```

Example `.env`:

```env
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
```

Do not put service role keys or real secrets into the client app.

## Development commands

```bash
# TypeScript check
npx tsc --noEmit

# Run mobile Expo app
npm start

# Run Web preview
npm run web

# Build desktop app
npm run build --workspace @idea-second-brain/desktop

# Create desktop portable zip
npm run dist:zip --workspace @idea-second-brain/desktop

# Test desktop sync conflict policy
node apps/desktop/scripts/test-sync-conflict.cjs

# Test desktop local HTTP sync roundtrip
node apps/desktop/scripts/test-local-http-sync.cjs

# iOS export smoke test
npx expo export --platform ios --output-dir .expo-ios-test
```

## Project structure

```text
.
├─ App.tsx                         # Main mobile UI
├─ src/                            # Mobile local storage / Supabase helper code
├─ packages/core/                  # Shared mobile/desktop types, Vault, sync logic
├─ apps/desktop/                   # Electron desktop app
├─ supabase/                       # DB schema / Edge Function related files
├─ docs/                           # Product and development docs
├─ samples/                        # Sample data
└─ locales/                        # i18n resource area
```

## Current MVP status

Completed:

- Mobile notes/reports → sync package export
- Desktop Vault creation/selection
- Desktop local HTTP receiver
- QR/URL-based mobile → desktop transfer
- Markdown Vault storage
- Hash/size/path validation
- `updatedAt`-based conflict skip
- Basic automated tests

Needs real-world operation checks:

- Actual iPhone + Windows transfer on the same Wi-Fi
- Windows Defender Firewall allow flow
- Whether the 12MB transfer limit is appropriate for large note sets
- Whether native in-app QR scanning is needed later

## Contributing

This project is open source. Contributions are welcome:

- Bug reports
- README/documentation improvements
- Mobile UX improvements
- Desktop Vault/sync stability improvements
- AI summary/report quality improvements
- i18n translations
- Tests

Please keep these rules in mind:

- Do not commit real API keys, `.env`, personal notes, or local Vault files.
- Prioritize user data ownership and the local-first direction.
- Protect the core loop: capture quickly, recover later.

## License

MIT License. See [LICENSE](./LICENSE) for details.
