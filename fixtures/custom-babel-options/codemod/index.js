const useRecast = process.env.USE_RECAST === 'true';

const codemod = {
  getPlugin: () => ({
    useRecast,
    plugin: () => ({
      visitor: {
        Identifier(path) {
          path.node.name = path.node.name.split('').reverse().join('');
        },
        StringLiteral(path) {
          path.node.value = path.node.value.split('').reverse().join('');
        }
      }
    })
  })
};

codemod.generatorOpts = useRecast ? {
  quote: 'single'
} : {
  retainFunctionParens: true
};

module.exports = codemod;