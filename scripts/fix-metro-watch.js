const fs = require('fs');
const path = require('path');

// Windows + Metro fallback watcher can try to watch optional msgpackr native package
// folders that npm did not install for the current platform. Empty folders avoid
// ENOENT watch crashes during local Expo development.
const base = path.join(__dirname, '..', 'node_modules', '@msgpackr-extract');
const optionalPackages = [
  'msgpackr-extract-linux-arm',
  'msgpackr-extract-linux-arm64',
  'msgpackr-extract-linux-x64',
  'msgpackr-extract-darwin-arm64',
  'msgpackr-extract-darwin-x64',
];

if (fs.existsSync(base)) {
  for (const name of optionalPackages) {
    fs.mkdirSync(path.join(base, name), { recursive: true });
  }
}
