const recast = require('recast');
const fs = require('fs');

const ast = recast.parse(fs.readFileSync('fixtures/arrow-function-inline-return/source/recast-oddities.js', 'utf8'));

console.log(recast.print(ast).code);