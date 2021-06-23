const recast = require('recast');
const fs = require('fs');

const source = `              console.log('leading');
`

// const ast = recast.parse(fs.readFileSync('fixtures/arrow-function-inline-return/source/recast-oddities.js', 'utf8'));
// const ast = recast.parse(
//   `
  
//   console.log('leading');
//   `
// );

// console.log(recast.print(ast).code);


const {parse: babelParse, transformSync: babelTransformSync} = require('@babel/core');
const _ = require('lodash');

function transform({source, filePath}) {
  const defaultBabelOpts = {
    filename: filePath,
    sourceType: 'module',
    presets: [],
    plugins: [],
    ast: true,
    parserOpts: {
      tokens: true
    }
  };
  const parser = {
    parse(sourceToParse, opts) {
      const optsToPass = _.omit(
        opts,
        'jsx',
        'loc',
        'locations',
        'range',
        'comment',
        'onComment',
        'tolerant',
        'ecmaVersion'
      );
      const babelOpts = {
        ...optsToPass,
        ...defaultBabelOpts
      };
      console.log({babelOpts});

      return babelParse(sourceToParse, babelOpts);
    }
  };

  

  console.log('attempting parse');
  const ast = recast.parse(source, {parser});

  console.log('Recast direct print:')
  console.log(recast.print(ast));

  const setAst = () => ({
    visitor: {
      Program(path) {
        path.replaceWith(ast.program);
      }
    }
  });

  const babelResult = babelTransformSync('', {
    ...defaultBabelOpts,
    plugins: [setAst]
  });

  console.log('After babel trivial transform:')
  console.log(recast.print(babelResult.ast));
}

transform({
  source,
  filePath: 'demo.js'
});
