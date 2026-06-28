# Desktop app

Windows-first desktop client for 생각회수기 / Thought Recovery.

## Current scope

This workspace is the local-first desktop companion for the mobile app.

Implemented in this loop:

- Electron + React + Vite desktop shell
- Vault folder creation/selection through Electron IPC
- Required Vault folders:
  - `notes/`
  - `reports/`
  - `attachments/audio/`
- `manifest.json` creation for a new Vault
- Vault overview counts for notes, reports, and audio files
- Sample Markdown note write for file I/O verification
- 5-minute local sync session placeholder
- Core sync transaction validation in `packages/core`

## Run

```bash
npm run build --workspace @idea-second-brain/desktop
npm run dist:zip --workspace @idea-second-brain/desktop
```

Portable preview output:

```text
apps/desktop/release/thought-recovery-desktop-win-portable.zip
```

## Next

- Replace placeholder sync sessions with QR/local transaction exchange.
- Add desktop file read/write adapter for real mobile sync packages.
- Add user-owned AI API adapter after sync storage is stable.
