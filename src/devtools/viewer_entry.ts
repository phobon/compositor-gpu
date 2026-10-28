// The standalone viewer's script for the CLI's HTML report
// (tools/profile/html.ts builds it as an IIFE, global
// `CompositorGpuViewer`): the viewer and the recording decoder.
export { decodeRecording } from '../profile/recording'
export { mountViewer } from './viewer'
