import createLog from 'nth-log';
import piscina from 'piscina';
import fs from 'fs';
import loadCodemod from './load-codemod';

const baseLog = createLog({name: 'jscodemod-worker'});

const pFs = fs.promises;

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function 
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */
const codemod = loadCodemod(piscina.workerData.codemodPath);

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