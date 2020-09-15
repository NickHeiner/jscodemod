#!/usr/bin/env node

/* eslint-disable */
// @ts-nocheck

require('ts-node')

const path = require('path');
const findUp = require('find-up');

const tsNode = findUp.sync(async directory => 
    path.basename(directory) === 'node_modules' && 
    await findUp.exists(path.join(directory, '.bin', 'ts-node-script'))
);