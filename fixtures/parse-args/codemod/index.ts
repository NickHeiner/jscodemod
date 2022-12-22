import {LowLevelCodemod} from '@nick.heiner/jscodemod';
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

const codemod: LowLevelCodemod<ReturnType<typeof yargsBuilder.parse>> = {
  parseArgs(rawCommandLineArgs) {
    return yargsBuilder.parse(rawCommandLineArgs!);
  },
  transform() {
    return null;
  },
  postProcess(_changedFiles, {codemodArgs}) {
    console.log(JSON.stringify({message: 'from postProcess', codemodArgs}));
  }
};

export default codemod;