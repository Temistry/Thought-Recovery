# Development Workflow

## Commit discipline

For this project, handle user instructions one at a time.

1. Pick one instruction or defect.
2. Make the smallest focused change for that instruction.
3. Run the relevant verification gate, usually `npx tsc --noEmit`.
4. Commit the app repository with a focused message.
5. Append the result to the Idea Second Brain wiki work log.
6. Commit and push the wiki work log separately.

Avoid bundling unrelated UI, storage, backend, and documentation changes into one app commit unless they are required by the same instruction.

## Current app repository

- App root: `C:\Users\kal91\.openclaw\workspace\idea-second-brain`
- Wiki vault: `C:\data\idea-second-brain`
- Wiki work log: `C:\data\idea-second-brain\00 Inbox\Work Log.md`

## Remote status

The app repository is currently managed as a local git repository. A GitHub remote should be connected before external backup/push is expected.
