const fs = require('fs');
const p = 'lib/runner.js';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\\x27/g, "'");
fs.writeFileSync(p, s);
console.log('ok');
