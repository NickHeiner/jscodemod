import _ from 'lodash';
import createLogger from 'nth-log';
import fs from 'fs';
import {TODO} from './types';

const getLogger = _.once((opts?: {
  jsonOutput: boolean;
  porcelain: boolean;
}) => {
  const logOpts: {name: string; stream?: TODO} = {name: 'jscodemod-coordinator'};
  if (opts?.jsonOutput) {
    logOpts.stream = process.stdout;
  }
  if (opts?.porcelain) {
    logOpts.stream = fs.createWriteStream('/dev/null');
  }
  return createLogger(logOpts);
});

export default getLogger;