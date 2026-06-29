const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const targets = [
  path.join(root, 'release', 'desktop', 'win-unpacked'),
  path.join(root, 'release', 'desktop', 'win-unpacked.tmp'),
];

let removed = 0;

for (const target of targets) {
  if (!fs.existsSync(target)) {
    continue;
  }

  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`removed ${path.relative(root, target)}`);
    removed += 1;
  } catch (error) {
    console.error(`failed to remove ${path.relative(root, target)}`);
    console.error(error.message);
    console.error('Close Thought Recovery and any Explorer window opened inside release/desktop, then run this command again.');
    process.exitCode = 1;
  }
}

if (removed === 0) {
  console.log('desktop release folders are already clean');
}
