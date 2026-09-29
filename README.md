# WhatsApp Voice Calling SDK

JavaScript SDK for **WhatsApp Business Calling** (Meta Calling APIs + WebRTC).

Use it to place and receive WhatsApp voice calls from a browser agent UI, and to orchestrate calls from Node.js.

**Package:** `@wa-voice/sdk`  
**Runtime:** Node.js 18+ · modern browsers (HTTPS or `localhost` for microphone)

---

## Install

```bash
npm install github:Veevo-Admin-Web/Spext_Voice_Call_SDK
npm install mediasoup-client
```

`mediasoup-client` is required only in the **browser** (peer dependency `^3.7.0`).

```javascript
import { VoiceAgentSDK, VoiceServerSDK, VoiceError } from '@wa-voice/sdk';
```

---

## Spext hosted API (production)

If you have a Spext WhatsApp account, you do **not** host the voice engine. You call the public gateway with your account **API hash** (copy-hash in Spext).

| Purpose | URL |
|---------|-----|
| Load SDK config | `GET https://spextbk.veevotech.com/bk-service-api/whatsapp/wa-calling/config` |
| REST `baseUrl` | `https://spextbk.veevotech.com/bk-service-api/whatsapp/wa-calling` |
| WebSocket `wsUrl` | `wss://spextbk.veevotech.com/bk-service-api/whatsapp/wa-calling/ws/agents` |

Always load config at runtime (do not hardcode if your platform gives you a config endpoint):

```javascript
const res = await fetch(
  'https://spextbk.veevotech.com/bk-service-api/whatsapp/wa-calling/config'
);
const { DB_DATA } = await res.json();
// DB_DATA.voice_api_base_url
// DB_DATA.voice_ws_url
```

Live tester (Spext login required):  
https://spext.veevotech.com/whatsapp/integrationplayground?tab=calling

---

## Quick start (browser)

**Always pass `wsUrl` from config.** If you omit it, the SDK derives `wss://{host}/ws/agents`, which is the wrong path on the Spext gateway.

```javascript
import { VoiceAgentSDK } from '@wa-voice/sdk';

const sdk = new VoiceAgentSDK({
  baseUrl: config.voice_api_base_url,
  wsUrl: config.voice_ws_url,
  hashKey: 'YOUR_ACCOUNT_HASH',   // from Spext copy-hash — do not commit this
  agentId: 'agent_user_42',       // unique per agent, never shared
  autoConnect: false,
});

sdk.on('wsConnected', () => console.log('ready to call'));
sdk.on('incomingCall', (call) => {
  // must run from a user click (microphone / autoplay)
  // sdk.acceptIncoming(call.call_id);
});
sdk.on('callStateChanged', (call) => console.log(call.status, call.displayStatus));
sdk.on('mediaReady', () => console.log('two-way audio'));
sdk.on('callEnded', (ended) => console.log(ended.terminate_status));
sdk.on('mediaError', ({ error }) => console.error(error.message));

await sdk.connect();          // wait until wsConnected
await sdk.dial('+923001234567', 'ticket_123');
```

`accountId` is optional. The SDK resolves it from `GET /voice/settings` using the hash.

On logout / unmount: `sdk.destroy()`.

---

## Authentication

Every REST call sends:

| Header | Required | Description |
|--------|----------|-------------|
| `x-hash-key` | yes | WhatsApp account hash from Spext |
| `x-account-id` | no | Numeric account id; resolved from hash if omitted |
| `Content-Type` | yes | `application/json` |

**Production:** keep the hash on **your backend**. Do not ship it in a public frontend bundle. Proxy `/voice/*` from your server, or issue a short-lived token.

WebSocket AUTH (handled by the SDK):

```json
{ "type": "AUTH", "agent_id": "agent_42", "account_id": "157" }
```

---

## Example REST call

`baseUrl` + path. Spext example:

```http
POST https://spextbk.veevotech.com/bk-service-api/whatsapp/wa-calling/voice/call/initiate
x-hash-key: YOUR_HASH_KEY
Content-Type: application/json

{
  "wa_id": "+923001234567",
  "opaque_data": "ticket_123"
}
```

`opaque_data` is optional, max 256 characters, echoed in call events for correlation.

---

## VoiceAgentSDK (browser)

| Option | Required | Description |
|--------|----------|-------------|
| `baseUrl` | yes | REST root (no trailing slash needed) |
| `hashKey` | yes | Account hash |
| `agentId` | yes | Stable unique agent id |
| `wsUrl` | **yes on Spext** | Full `wss://…/wa-calling/ws/agents` |
| `accountId` | no | Resolved from hash if omitted |
| `autoConnect` | no | Default `true`. Prefer `false`, then `await sdk.connect()` after listeners |
| `mediaOptions` | no | Passed to WebRTC layer |

### Call controls

| Action | Method |
|--------|--------|
| Connect WS | `connect()` |
| Outbound | `dial(waId, opaqueData?)` — call from a **click** |
| Check permission | `getPermissionStatus(waId)` |
| Accept inbound | `acceptIncoming(callId)` — from a **click** |
| Dismiss banner | `dismissIncoming(callId)` (local UI only) |
| Hang up | `hangup()` |
| Mute | `toggleMute()` |
| Mic again | `requestMicrophone()` |
| Enable calling | `enableCalling(options?)` |
| Cleanup | `destroy()` |

Wait until WebSocket is connected before `dial()`.

### Events

| Event | When |
|-------|------|
| `wsConnected` | WS authenticated |
| `wsDisconnected` | WS closed |
| `wsError` | Initial connect failed |
| `incomingCall` | Inbound call |
| `incomingDismissed` | Banner dismissed |
| `callStateChanged` | Lifecycle update (`status`, `displayStatus`, `direction`) |
| `micReady` / `mediaSendReady` | Mic / send path ready |
| `mediaReady` | Remote audio / full duplex |
| `mediaWarning` | Audio still connecting |
| `mediaError` | WebRTC failed |
| `callEnded` | Call finished |
| `muteChanged` | `{ muted }` |
| `permissionApproved` / `permissionDeclined` | CPR result |

Statuses: `INITIATING` → `INITIATED` → `RINGING` → `CONNECTING` → `ACTIVE` → `TERMINATED`.  
For outbound, prefer `displayStatus` in the UI (callee may still be ringing while media connects).

---

## VoiceServerSDK (Node.js)

Orchestration only — **no microphone / WebRTC**. The agent browser must still run `VoiceAgentSDK`.

```javascript
import { VoiceServerSDK } from '@wa-voice/sdk';

const voice = new VoiceServerSDK({
  baseUrl: process.env.VOICE_API_BASE_URL,
  hashKey: process.env.VOICE_HASH_KEY,
});

const { status } = await voice.ensureCallPermission(waId);
if (status !== 'APPROVED') {
  throw new Error(`Call permission is ${status}`);
}

const { call_id } = await voice.initiateOutboundCall(waId, 'ticket_123');
```

For Spext, set `VOICE_API_BASE_URL` to the public REST base above (same as `voice_api_base_url`).

---

## REST surface

Paths are relative to `baseUrl`. Response envelope:

```json
{
  "STATUS": "SUCCESSFUL",
  "DB_DATA": {},
  "ERROR_FILTER": "",
  "ERROR_CODE": "",
  "ERROR_DESCRIPTION": ""
}
```

Failures throw `VoiceError`.

| Method | Path | Client | Agent SDK | Server SDK |
|--------|------|--------|-----------|------------|
| `GET` | `/voice/settings` | `getSettings()` | `getSettings()` | `getCallSettings()` |
| `PATCH` | `/voice/settings` | `updateSettings(patch)` | `updateSettings(patch)` | `updateCallSettings(patch)` |
| `GET` | `/voice/permission/status/:wa_id` | `getPermissionStatus(waId)` | `getPermissionStatus(waId)` | `ensureCallPermission` |
| `POST` | `/voice/call/initiate` | `initiateCall(waId, opaque?)` | `dial()` | `initiateOutboundCall` |
| `POST` | `/voice/call/:id/accept-incoming` | `acceptIncomingCall` | `acceptIncoming` | — |
| `POST` | `/voice/call/:id/terminate` | `terminateCall` | `hangup` | `terminateCall` |
| `GET` | `/voice/call/:id/status` | `getCallStatus` | (internal) | `getCallStatus` / `waitForCallStatus` |
| `GET` | `/voice/calls/active` | `getActiveCalls` | (internal) | `getActiveCalls` |
| `GET` | `/voice/calls/history` | `getCallHistory(page, limit)` | — | `getCallHistory` |
| `POST` | `/voice/calling/enable` | `enableCalling(options)` | `enableCalling` | `enableCallingForAccount` |

WebRTC transport routes (`agent-transport`, `agent-produce`, `agent-consume`, …) are used internally by `VoiceAgentSDK`. You do not call them if you use the high-level SDK.

---

## React sketch

```javascript
import { useEffect, useRef, useState } from 'react';
import { VoiceAgentSDK } from '@wa-voice/sdk';

export function useVoiceAgent({ baseUrl, wsUrl, hashKey, agentId }) {
  const sdkRef = useRef(null);
  const [activeCall, setActiveCall] = useState(null);

  useEffect(() => {
    const sdk = new VoiceAgentSDK({
      baseUrl,
      wsUrl,
      hashKey,
      agentId,
      autoConnect: false,
    });
    sdkRef.current = sdk;
    sdk.on('callStateChanged', setActiveCall);
    sdk.on('callEnded', () => setActiveCall(null));
    sdk.connect();
    return () => sdk.destroy();
  }, [baseUrl, wsUrl, hashKey, agentId]);

  return {
    dial: (waId) => sdkRef.current?.dial(waId),
    hangup: () => sdkRef.current?.hangup(),
    activeCall,
  };
}
```

---

## Errors

```javascript
import { VoiceError } from '@wa-voice/sdk';

try {
  await sdk.dial(waId);
} catch (err) {
  if (err instanceof VoiceError) {
    console.error(err.error_code, err.error_description, err.http_status);
  }
}
```

| Code | Meaning |
|------|---------|
| `VTVE-XXX17` | Invalid account hash |
| `VTVE-XXX21` | Calling not enabled |
| `VTVE-XXX23` | Outside business hours |
| `VTVE-XXX24` | No approved call permission |
| `VTVE-XXX28` | Call permission request rate limit |
| `VTVE-XXX35` | Call not found / already terminated |

---

## Requirements and limits

- Calling must be **enabled** for the WhatsApp number (portal or `enableCalling()`).
- Outbound: contact must have **APPROVED** call permission.
- `dial` / `acceptIncoming` must run from a **user gesture** (mic + audio).
- Browser must be HTTPS or `localhost`.
- UDP media ports on the voice media host must be reachable from the agent browser.
- Permission request limits (per contact, per account): 3 / 24h, 10 / 7 days; four unanswered calls can revoke permission.
- `mediasoup-client` `^3.7` with server mediasoup `^3.14`.

Outbound `initiate` returns a temporary `call_id` first; the SDK remaps it when Meta connects. Use SDK events, do not assume the id stays `temp_*`.

---

## Security

- Never commit `hashKey` or put it in a public client.
- Prefer: user logs into **your** app → your backend holds the hash → browser uses the SDK only after your session is valid.
- This repository is the **client SDK only**. It does not include the voice engine or admin APIs.

---

## License

ISC
