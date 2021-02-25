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

export type CodemodMetaResult = {
  filePath: string;
  codeModified: boolean;
  fileContents: string;
}
export default async function main(sourceCodeFile: string): Promise<CodemodMetaResult> {
  const log = baseLog.child({sourceCodeFile});
  log.debug({action: 'start'});

  const originalFileContents = await pFs.readFile(sourceCodeFile, 'utf-8');
  const parsedArgs = await codemod.parseArgs?.(piscina.workerData.codemodArgs);

  // TODO: Handle the codemod throwing an error?
  const transformedCode = await codemod.transform({
    source: originalFileContents, 
    filePath: sourceCodeFile, 
    commandLineArgs: parsedArgs
  });
  const codeModified = Boolean(transformedCode && transformedCode !== originalFileContents);

  const {writeFiles} = piscina.workerData; 
  if (codeModified && writeFiles) {
    // This non-null assertion is safe because `codeModified` includes a check on `transformedCode`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await pFs.writeFile(sourceCodeFile, transformedCode!);
  }
  log.debug({action: codeModified ? 'modified' : 'skipped', writeFiles});
  return {
    codeModified, 
    fileContents: transformedCode ? transformedCode : originalFileContents,
    filePath: sourceCodeFile
  };
}