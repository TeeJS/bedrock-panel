'use strict';
// Quit guard: decides whether quitting would cut off live work (a recording or a transcription) and
// builds the confirmation text. Pure, so the main process only wires it to the dialog.

// busyReasons({ recording, transcribing }) -> ['recording', 'transcription'] (empty when idle)
function busyReasons(s) {
  const out = [];
  if (s && s.recording) out.push('recording');
  if (s && s.transcribing) out.push('transcription');
  return out;
}

// True when the transcriber's getState() shows a running job or a queue.
function isTranscribing(state) {
  return !!(state && (state.current || (Array.isArray(state.queue) && state.queue.length)));
}

function quitPrompt(reasons) {
  const both = reasons.length > 1;
  const what = both ? 'A recording and a transcription are' : reasons[0] === 'recording' ? 'A recording is' : 'A transcription is';
  return {
    message: what + ' in progress.',
    detail: 'Closing Bedrock Panel now will ' + (both ? 'stop them' : 'stop it') + '. Do you really want to close?',
  };
}

module.exports = { busyReasons, isTranscribing, quitPrompt };
