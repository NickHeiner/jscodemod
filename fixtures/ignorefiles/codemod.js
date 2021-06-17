const path = require('path');

module.exports = {
  transform() { 
    return 'transformed';
  },
  ignoreFiles: [path.resolve(__dirname, 'root.ignore'), 'dir-1/nested.ignore']
};