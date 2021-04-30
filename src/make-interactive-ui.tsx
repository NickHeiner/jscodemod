// I think it's getting confused with JSX.
// eslint-disable-next-line no-use-before-define
import React from 'react';

import {render, Text, Box} from 'ink';
import ProgressBar from 'ink-progress-bar';
import SyntaxHighlight from 'ink-syntax-highlight';
import _ from 'lodash';
import {CliUi} from './types';

type FileListProps = {files: string[]};
const FileList = (props: FileListProps) => {
  const fileLimit = 10;
  const extraFiles = props.files.length - fileLimit;
  return <Box flexDirection='column'>
    {props.files.slice(0, fileLimit).map(file => <Text key={file}>{file}</Text>)}
    {extraFiles > 0 && <Text>({extraFiles} files not shown.)</Text>}
  </Box>;
};

export type ArbitraryError = Error & Record<string, unknown>;

export type DetectResults = {
  /**
   * Map of {label: filesMatchingThisLabel[]}
   */
  byLabel: Record<string, string[]>;

  /**
   * Map of {filePath: error}
   */
  errored: Record<string, ArbitraryError>;
}
type Props = {
  phase: 'reacting';
  filesToScan: number;
  filesScanned: number;
} | {
  detectResults: DetectResults
} | {
  debugEntries: Record<string, unknown[]>
}

const ShowDetectResults = (props: {detectResults: DetectResults}) => {
  if (props.detectResults.errored.length) {
    return <Box flexDirection='column'>
      <Text>At least one error occurred. Here's one:</Text>
      <Text>{Object.values(props.detectResults.errored)[0].message}</Text>
    </Box>;
  }

  return <>{
    _(props.detectResults.byLabel)
      .toPairs()
      .sortBy(0)
      .map(([label, files]) => 
        <Box flexDirection='column' key={label} paddingRight={5}>
          <Text>{label}</Text>
          <FileList files={files} />
        </Box>
      )
      .value()
  }</>;
};

const ShowDebugEntries = (props: {debugEntries: Record<string, unknown[]>}) => {
  const [file, logLines] = Object.entries(props.debugEntries)[0];
  return <Box flexDirection='column'>
    <Text>debugLog() was called for at least one file. Here's one:</Text>
    <Text>{file}</Text>
    {
      // It's ok to do key={index} here because perf isn't a concern.
      logLines.map((logEntry, index) => <SyntaxHighlight key={index} code={JSON.stringify(logEntry, null, 2)} />)
    }
  </Box>;
};

const App = (props: Props) => {
  if ('phase' in props) {
    return <Box flexDirection='column'>
      <Text>Compiling and scanning... ({props.filesScanned} / {props.filesToScan})</Text>
      <ProgressBar percent={props.filesScanned / props.filesToScan} />
    </Box>;
  }

  return <Box>
    {
      'detectResults' in props 
        ? <ShowDetectResults {..._.pick(props, 'detectResults')} />
        : <ShowDebugEntries {..._.pick(props, 'debugEntries')} />
    }
  </Box>;
};

const makeInteractiveUI = (): CliUi => {
  const {rerender} = render(<App phase='reacting' filesScanned={0} filesToScan={0} />);

  const showReacting = (filesScanned: number, filesToScan: number) => {
    rerender(<App phase='reacting' filesScanned={filesScanned} filesToScan={filesToScan} />);
  };

  const showDetectResults = (detectResults: DetectResults) => {
    rerender(<App detectResults={detectResults} />);
  };

  const showDebug = (debugEntries: Record<string, unknown[]>) => {
    rerender(<App debugEntries={debugEntries} />); 
  };

  return {
    showReacting, showDetectResults, showDebug
  };
};

export default makeInteractiveUI;