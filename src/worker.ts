import baseLog from 'nth-log';
import {Codemod} from './types';
import piscina from 'piscina';
import fs from 'fs';

const pFs = fs.promises;

function getCodemod(codemodPath: string): Codemod {
  // We need a dynamic require here.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const codemod = require(codemodPath);

  return codemod.default || codemod;
}

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function 
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */
const codemod = getCodemod(piscina.workerData.codemodPath);

export default async function main(sourceCodeFile: string): Promise<void> {
  const log = baseLog.child({sourceCodeFile});
  log.debug({action: 'start'});

  const fileContents = await pFs.readFile(sourceCodeFile, 'utf-8');
  const transformedCode = await codemod.transform({source: fileContents, filePath: sourceCodeFile});
  if (transformedCode) {
    await pFs.writeFile(sourceCodeFile, transformedCode);
  }
  log.debug({action: transformedCode ? 'modified' : 'skipped'});
}