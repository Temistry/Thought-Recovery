const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const release = path.join(root, 'release');
const staging = path.join(release, 'thought-recovery-desktop-win-portable');
const zipPath = path.join(release, 'thought-recovery-desktop-win-portable.zip');

if (!fs.existsSync(dist)) throw new Error('Desktop dist folder is missing. Run npm run build first.');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
fs.cpSync(dist, path.join(staging, 'app'), { recursive: true });
fs.cpSync(path.join(root, 'electron'), path.join(staging, 'electron'), { recursive: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(staging, 'package.json'));
fs.writeFileSync(path.join(staging, 'README.txt'), [
  '생각회수기 Desktop portable preview',
  '',
  'This is an early Windows portable skeleton package.',
  'Run with Electron during development: npm run electron --workspace @idea-second-brain/desktop',
].join('\r\n'), 'utf8');
fs.rmSync(zipPath, { force: true });
execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
console.log(zipPath);
