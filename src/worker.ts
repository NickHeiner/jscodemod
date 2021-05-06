import createLog from 'nth-log';
import piscina from 'piscina';
import loadCodemod from './load-codemod';
import type {DetectLabel} from './types';
import _ from 'lodash';
import runCodemodOnFile from './run-codemod-on-file';

// I wonder if we could measure perf gains by trimming this import list.

const baseLog = createLog({name: 'jscodemod-worker'});

/**
 * I don't think we can share this instance across workers – I got an error that said the transform function 
 * "could not be cloned" when I tried to pass the codemod itself on `workerData`.
 */
const codemod = loadCodemod(piscina.workerData.codemodPath);

export type BaseCodemodMeta = {
  filePath: string;
  fileContents: string;
};

export type TransformMeta = {
  codeModified: boolean;
} & BaseCodemodMeta;

export type DetectMeta = {
  label?: DetectLabel;
} & BaseCodemodMeta;

export type ErrorMeta = {
  error: Error
} & BaseCodemodMeta;

export type DebugMeta = {
  debugEntries: unknown[]
} & BaseCodemodMeta;

export type CodemodMetaResult = TransformMeta | DetectMeta | ErrorMeta | DebugMeta;

export default function main(sourceCodeFile: string): Promise<CodemodMetaResult> {
  return runCodemodOnFile(
    codemod, sourceCodeFile, baseLog, _.pick(piscina.workerData, 'codemodArgs', 'writeFiles', 'alwaysTransform')
  );
}