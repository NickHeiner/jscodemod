const codemod = {
  getPlugin: () => () => ({
    visitor: {
      Identifier(path) {
        path.node.name = path.node.name.split('').reverse().join('');
      }
    }
  }),

  babelTransformOptions: {
    generatorOpts: {
      compact: true
    }
  }
};

export default codemod;