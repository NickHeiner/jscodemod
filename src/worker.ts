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

export default async function main(sourceCodeFile: string): Promise<boolean> {
  const log = baseLog.child({sourceCodeFile});
  log.debug({action: 'start'});

  const fileContents = await pFs.readFile(sourceCodeFile, 'utf-8');
  const transformedCode = await codemod.transform({
    source: fileContents, 
    filePath: sourceCodeFile, 
    commandLineArgs: piscina.workerData.codemodArgs
  });
  const codeModified = Boolean(transformedCode && transformedCode !== fileContents);

  // log.warn({
  //   codeModified, transformedCode, fileContents
  // })

  if (codeModified) {
    // This non-null assertion is safe because `codeModified` includes a check on `transformedCode`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await pFs.writeFile(sourceCodeFile, transformedCode!);
  }
  log.debug({action: codeModified ? 'modified' : 'skipped'});
  return codeModified;
}