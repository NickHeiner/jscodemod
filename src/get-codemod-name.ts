import { Codemod } from './types';
import path from 'path';

function getCodemodName(codemod: Codemod, pathToCodemod: string | null): string {
  if (codemod.name) {
    return codemod.name;
  }
  if (pathToCodemod) {
    return path.basename(pathToCodemod);
  }
  return 'could-not-determine-name';
}

export default getCodemodName;
