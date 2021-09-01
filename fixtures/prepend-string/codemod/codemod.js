const silenceableLog = (...args) => {
  if (process.env.SILENT === 'true') {
    return;
  }

  console.log(...args);
}

module.exports = {
  ignore: [
    /codemod-ignored/,
    'input-file-list.txt',
    'omitted-via-string-pattern'
  ],
  postProcess: (modifiedFiles, {resultMeta}) => {
    silenceableLog('codemod post process', JSON.stringify(modifiedFiles));
    silenceableLog('resultMeta as passed to post process', JSON.stringify([...resultMeta.entries()]));
  },
  parseArgs: rawCommandLineArgs => ({rawCommandLineArgs}),
  transform({source, commandLineArgs, filePath}) {
    silenceableLog('commandLineArgs', JSON.stringify(commandLineArgs));
    return {
      meta: `meta for ${filePath}`,
      code: `/* prefix prepend string */\n${source}`
    };
  }
};