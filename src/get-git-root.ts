import findUp from 'find-up';
import path from 'path';

async function getGitRoot(inputFilesPaths: string[]): Promise<string | null> {
  // Assume that all files are in the same .git root, and there are no submodules.
  const arbitraryFilePath = path.dirname(inputFilesPaths[0]);
  const gitDir = await findUp('.git', { cwd: arbitraryFilePath, type: 'directory' });
  if (!gitDir) {
    return null;
  }
  // We want to pop up a level, since we want a directory we can execute git from, and you can't execute git
  // from the .git directory itself.
  return path.resolve(gitDir, '..');
}

export default getGitRoot;
