const babel = require('@babel/core');
const recast = require('recast');
const _ = require('lodash');

const filename = 'file.js';
const source = `
function f(
  a,
  b,
  c
) {
  return d;
}
`;

const babelOpts = {
  filename,
  ast: true
};

const parser = {
  parse(source, opts) {
    return babel.parse(source, {
      ...babelOpts,
      ..._.omit(
        opts, 
        'jsx', 'loc', 'locations', 'range', 'comment', 'onComment', 'tolerant', 'ecmaVersion'
      )
    });
  }
};

const ast = recast.parse(source, {parser});
const result = babel.transformFromAstSync(ast, source, babelOpts);

const printedFromRecastParse = recast.print(ast).code;
const printedFromBabelTransform = recast.print(result.ast).code;

console.log('printedFromRecastParse', printedFromRecastParse);
console.log();
console.log('printedFromBabelTransform', printedFromBabelTransform);