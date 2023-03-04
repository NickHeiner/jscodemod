import path from 'path';

export default function pathIsTS(filePath: string): boolean {
  return path.extname(filePath) === '.ts';
}
