import {Codemod} from '@nick.heiner/jscodemod';
import yargs from 'yargs';

const yargsBuilder = yargs.options({
  requiredFlag: {
    alias: 'r',
    type: 'string',
    required: true,
    describe: 'This arg is required'
  }
})
  .help();

const codemod: Codemod<ReturnType<typeof yargsBuilder.parse>> = {
  parseArgs(rawCommandLineArgs) {
    return yargsBuilder.parse(rawCommandLineArgs!);
  },
  transform() {
    return null;
  }
};

export default codemod;