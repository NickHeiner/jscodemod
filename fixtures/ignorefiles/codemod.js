const path = require('path');

module.exports = {
  transform() { 
    return 'transformed';
  },
  ignoreFiles: [path.resolve(__dirname, 'root.ignore'), path.resolve(__dirname, 'dir-1/nested.ignore')]
};