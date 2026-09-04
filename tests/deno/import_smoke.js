/* eslint-disable unicorn/filename-case */
// The generated Deno import map resolves this package to the extracted artifact.
// eslint-disable-next-line import-x/no-unresolved
import Analytics from '@rudderstack/rudder-sdk-node';

if (typeof Analytics !== 'function') {
  throw new Error('The SDK package did not export its constructor.');
}
