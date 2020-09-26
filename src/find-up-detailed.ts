import findUp from 'find-up';
import path from 'path';
import {PromiseType} from 'utility-types';

type DetailedFindUpResult = {
  foundPath: PromiseType<ReturnType<typeof findUp>>;
  checkedPaths: string[];
};

async function findUpDetailed(
  fileOrDirectory: string, opts: Parameters<typeof findUp>[1]
): Promise<DetailedFindUpResult> {
  const checkedPaths: string[] = [];
  const foundPath = await findUp(directory => {
    const pathToCheck = path.join(directory, fileOrDirectory);
    checkedPaths.push(pathToCheck);
    return findUp.exists(pathToCheck) && directory;
  }, opts);
  return {foundPath, checkedPaths};
}

export default findUpDetailed;