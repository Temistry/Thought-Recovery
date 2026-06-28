# Desktop app

Windows-first desktop client for 생각회수기 / Thought Recovery.

## Current scope

This workspace is the local-first desktop companion for the mobile app.

Implemented:

- Electron + React + Vite desktop shell
- Vault folder creation/selection through Electron IPC
- Required Vault folders:
  - `notes/`
  - `reports/`
  - `attachments/audio/`
- `manifest.json` creation for a new Vault
- Vault overview counts for notes, reports, and audio files
- Sample Markdown note write for file I/O verification
- Sync transaction package apply/import path
- 5-minute local HTTP sync receiver
- Sync receiver URL copy and QR display
- `updatedAt` conflict policy: older incoming files are skipped
- Core sync transaction validation/apply planning in `packages/core`

## Run

```bash
npm run build --workspace @idea-second-brain/desktop
npm run dist:zip --workspace @idea-second-brain/desktop
```

Portable preview output:

```text
apps/desktop/release/thought-recovery-desktop-win-portable.zip
```

## Local mobile → desktop sync flow

1. Open the desktop app.
2. Create or select a Vault folder.
3. Click `수신 세션 열기`.
4. Desktop shows a 5-minute sync URL and QR.
5. On iPhone, use one of these MVP paths:
   - Copy the desktop URL and paste it into mobile settings → data → desktop sync URL.
   - Or scan the desktop QR with the iPhone Camera app, copy/open the URL, then paste it into the app field.
6. Tap `보내기` in mobile settings.
7. Desktop validates hash/size/path and applies newer files to the Vault.

## Firewall notes

- Phone and Windows PC must be on the same Wi-Fi/LAN.
- Windows Defender Firewall may ask whether to allow the Electron app/node process on private networks.
- If sync fails, allow the desktop app on private networks, reopen the 5-minute session, and retry.

## Conflict policy

- If the Vault file does not exist, incoming file is applied.
- If incoming `updatedAt` is newer than the existing Markdown frontmatter `updatedAt`, incoming file is applied.
- If existing file is newer or same timestamp, incoming file is skipped.
- Skipped count is shown in the desktop transaction result.

## Next

- Native in-app QR scan can be added later with a camera dependency/dev build pass.
- Add richer conflict review UI after real-world QA.
