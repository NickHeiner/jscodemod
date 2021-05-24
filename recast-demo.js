const recast = require('recast');

const ast = recast.parse(`
  const e = () => function(g, h) {
    return i;
  };

`)

console.log(recast.print(ast).code);