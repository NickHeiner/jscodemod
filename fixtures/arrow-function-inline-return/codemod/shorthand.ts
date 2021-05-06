import {Codemod} from '../../..';
import babelPlugin from './babel-plugin';
import _ from 'lodash';

const codemod: Codemod = {
  presets: [],
  getPlugin: () => ['@babel/plugin-syntax-optional-chaining', '@babel/plugin-syntax-typescript', babelPlugin]
};

export default codemod;