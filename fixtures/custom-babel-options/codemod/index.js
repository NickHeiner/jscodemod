const useRecast = process.env.USE_RECAST === 'true';

const codemod = {
  getPlugin: () => ({
    useRecast,
    plugin: () => ({
      visitor: {
        Identifier(path) {
          path.node.name = path.node.name.split('').reverse().join('');
        }
      }
    })
  })
};

codemod.generatorOpts = useRecast ? {
  trailingComma: true
} : {
  retainFunctionParens: true
};

module.exports = codemod;