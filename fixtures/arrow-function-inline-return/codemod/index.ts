import {Codemod} from '@nth/jscodemod';
import babelPlugin from './babel-plugin';
import _ from 'lodash';

const codemod: Codemod = {
  getPlugin: () => babelPlugin,
  presets: ['@babel/preset-typescript', '@babel/preset-env']
};

export default codemod;