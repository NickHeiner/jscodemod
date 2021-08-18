module.exports = {
  ignore: [
    /codemod-ignored/,
    'input-file-list.txt',
    'omitted-via-string-pattern'
  ],
  postProcess: (modifiedFiles, {resultMeta}) => {
    console.log('codemod post process', JSON.stringify(modifiedFiles));
    console.log('resultMeta as passed to post process', JSON.stringify([...resultMeta.entries()]));
  },
  parseArgs: rawCommandLineArgs => ({rawCommandLineArgs}),
  transform({source, commandLineArgs, filePath}) {
    console.log('commandLineArgs', JSON.stringify(commandLineArgs));
    return {
      meta: `meta for ${filePath}`,
      code: `/* prefix prepend string */\n${source}`
    };
  }
};