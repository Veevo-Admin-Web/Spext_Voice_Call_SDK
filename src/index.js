/**
 * @wa-voice/sdk — Official WA Voice Engine SDK
 *
 * Browser (agent UI):
 *   import { VoiceAgentSDK } from '@wa-voice/sdk';
 *
 * Node.js (backend):
 *   import { VoiceServerSDK } from '@wa-voice/sdk';
 */

export { VoiceApiClient } from './VoiceApiClient.js';
export { VoiceError } from './VoiceError.js';
export { VoiceAgentSDK } from './browser/VoiceAgentSDK.js';
export { VoiceServerSDK } from './node/VoiceServerSDK.js';
export { AgentWebSocket } from './browser/AgentWebSocket.js';
export { AgentMedia } from './browser/AgentMedia.js';
export * from './constants.js';
