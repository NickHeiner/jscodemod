// I think it's getting confused with JSX.
// eslint-disable-next-line no-use-before-define
import React from 'react';

import {render, Text, Box, Spacer} from 'ink';

type FileListProps = {files: string[]};
const FileList = (props: FileListProps) => {
  const fileLimit = 10;
  const extraFiles = props.files.length - 10;
  return <Box flexDirection='column'>
    {props.files.slice(0, fileLimit).map(file => <Text key={file}>{file}</Text>)}
    {extraFiles > 0 && <Text>({extraFiles} files not shown.)</Text>}
  </Box>;
};

export type DetectResults = {
  matching: string[],
  notMatching: string[],
  errored: string[]
}
export type Phase = 'reacting' | 'showing-results'
type Props = {
  phase: 'reacting';
} | {
  phase: 'showing-results';
  detectResults: DetectResults
}

const App = (props: Props) => {
  if (props.phase === 'reacting') {
    return <Text>Compiling and scanning...</Text>;
  }

  return <Box flexDirection='column'>
    <Text>Matching files:</Text>
    <FileList files={props.detectResults.matching} />
    <Spacer />
    <Text>Not matching files:</Text>
    <FileList files={props.detectResults.notMatching} />
  </Box>;
};

type InteractiveUI = {
  showReacting: () => void;
  showDetectResults: (detectResults: DetectResults) => void;
}

const makeInteractiveUI = (): InteractiveUI => {
  const {rerender} = render(<App phase='reacting' />);

  const showReacting = () => {
    rerender(<App phase='reacting' />);
  };

  const showDetectResults = (detectResults: DetectResults) => {
    rerender(<App phase='showing-results' detectResults={detectResults} />);
  };

  return {
    showReacting, showDetectResults
  };
};

export default makeInteractiveUI;