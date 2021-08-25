module.exports = {
  presets: [],
  getPlugin({willNotifyOnAstChange, setMetaResult}) {
    willNotifyOnAstChange();
    return ({}) => ({
      visitor: {
        CallExpression(path) {
          if (path.node.callee.type === 'Identifier' && path.node.callee.name === 'g') {
            setMetaResult(path.node.arguments.length);
          }
        }
      }
    });
  },
  postProcess(_, {resultMeta}) {
    console.log(resultMeta);
  }
};