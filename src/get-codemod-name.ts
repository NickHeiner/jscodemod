import {Codemod} from './types';
import path from 'path';

const getCodemodName = (codemod: Codemod, pathToCodemod: string): string =>
  codemod.name ?? path.basename(pathToCodemod);

export default getCodemodName;