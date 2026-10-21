const fs = require('fs');
const p = 'C:/Users/Pc/3D Objects/leads/bot/gbp-scraper/lib/runner.js';
let s = fs.readFileSync(p, 'utf8');
s = s.split('\\n').join('\n');
fs.writeFileSync(p, s);
console.log('done');
