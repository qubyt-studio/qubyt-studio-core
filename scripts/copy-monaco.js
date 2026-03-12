const fs = require('fs');
const path = require('path');

const from = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'min', 'vs');
const to = path.join(__dirname, '..', 'src', 'renderer', 'vs');

if (!fs.existsSync(from)) {
  console.warn('monaco-editor not found, run npm install first');
  process.exit(0);
}

if (fs.existsSync(to)) {
  fs.rmSync(to, { recursive: true });
}
fs.cpSync(from, to, { recursive: true });
console.log('Monaco vs copied to src/renderer/vs');
