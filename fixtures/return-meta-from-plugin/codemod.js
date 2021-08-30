const silenceableLog = (...args) => {
  if (process.env.SILENT === 'true') {
    return;
  }

  console.log(...args);
}

module.exports = {
  presets: ['@babel/preset-env'],
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
    silenceableLog(resultMeta);
  }
};