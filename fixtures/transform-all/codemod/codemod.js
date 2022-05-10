const fs = require('fs');
const util = require('util');

const silenceableLog = (...args) => {
  if (process.env.SILENT === 'true') {
    return;
  }

  console.log(...args);
}

module.exports = {
  postProcess: (modifiedFiles, {resultMeta}) => {
    silenceableLog('codemod post process', JSON.stringify(modifiedFiles));
    silenceableLog('resultMeta as passed to post process', JSON.stringify([...resultMeta.entries()]));
  },
  async transformAll({fileNames}) {
    for (const fileName of fileNames) {
      await util.promisify(fs.rename)(fileName, `${fileName}.new`)
    }
    return fileNames;
  }
};