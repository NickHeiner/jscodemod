import globby from 'globby';

async function codemod(pathToCodemod: string, inputFilesPatterns: string[], {tsconfig}: {tsconfig: string}) {
  const inputFiles = await globby(inputFilesPatterns);
}

export default codemod;