// Builds a single-file, practice-only version of the game (no server needed).
// Usage: node build-practice.js [output-file]
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'public');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const engine = fs.readFileSync(path.join(dir, 'game.js'), 'utf8');
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const body = html.match(/<body>([\s\S]*?)<script src="game.js"><\/script>/)[1];
const script = html.match(/<script>\n([\s\S]*?)<\/script>\s*<\/body>/)[1];
const out = [
  '<title>Turf Party</title>',
  '<style>' + style + '</style>',
  body,
  '<script>window.TURF_OFFLINE = true;\n' + engine + '</script>',
  '<script>\n' + script + '</script>'
].join('\n');
fs.writeFileSync(process.argv[2] || path.join(__dirname, 'practice.html'), out);
console.log('wrote', out.length, 'bytes');
