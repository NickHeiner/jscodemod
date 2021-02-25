import {Codemod} from '@nth/jscodemod';
import yargs from 'yargs';

const codemod: Codemod = {
  parseArgs(rawCommandLineArgs = '') {
    return yargs.options({
      requiredFlag: {
        alias: 'r',
        type: 'string',
        required: true,
        describe: 'This arg is required'
      }
    })
      .help()
      .parse(rawCommandLineArgs);
  },
  transform({commandLineArgs}) {
    console.log({commandLineArgs});
    return null;
  }
};

export default codemod;