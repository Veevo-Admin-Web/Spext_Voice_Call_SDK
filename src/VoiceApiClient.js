/**
 * Low-level REST client for the WA Voice consumer API (/voice/*).
 * Works in Node.js 18+ and modern browsers (uses native fetch).
 */
import { VoiceError } from './VoiceError.js';
import { API_STATUS } from './constants.js';

/** Detached `fetch` reference throws "Illegal invocation" in browsers — always wrap. */
const defaultFetch = (...args) => globalThis.fetch(...args);

export class VoiceApiClient {
  /**
   * @param {object} config
   * @param {string} config.baseUrl - e.g. https://voice.example.com
   * @param {number|string} [config.accountId] - optional; resolved from hash when omitted
   * @param {string} config.hashKey
   * @param {typeof fetch} [config.fetchImpl] - override fetch (testing / polyfill)
   */
  constructor({ baseUrl, accountId = null, hashKey, fetchImpl = defaultFetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.accountId = accountId != null && String(accountId).trim() !== ''
      ? String(accountId)
      : null;
    this.hashKey = hashKey;
    this.fetchImpl = fetchImpl;
  }

  setCredentials(accountId, hashKey) {
    this.accountId = accountId != null && String(accountId).trim() !== ''
      ? String(accountId)
      : null;
    this.hashKey = hashKey;
  }

  async _request(method, path, body = null, query = null) {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-hash-key': this.hashKey,
    };
    if (this.accountId) {
      headers['x-account-id'] = this.accountId;
    }
    if (typeof window !== 'undefined' && window.location?.hostname) {
      headers['x-voice-portal-host'] = window.location.hostname;
    }

    const opts = { method, headers };
    if (body !== null) {
      opts.body = JSON.stringify(body);
    }

    const res = await this.fetchImpl(url, opts);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new VoiceError('Invalid JSON response from voice API', { http_status: res.status });
    }

    if (data.STATUS !== API_STATUS.SUCCESSFUL) {
      throw VoiceError.fromApiResponse(data, res.status);
    }

    return data.DB_DATA ?? {};
  }

  // ─── Settings ───────────────────────────────────────────────────────────

  getSettings() {
    return this._request('GET', '/voice/settings');
  }

  updateSettings(patch) {
    return this._request('PATCH', '/voice/settings', patch);
  }

  // ─── Permissions ────────────────────────────────────────────────────────

  getPermissionStatus(waId) {
    return this._request('GET', `/voice/permission/status/${encodeURIComponent(waId)}`);
  }

  // ─── Calls ──────────────────────────────────────────────────────────────

  initiateCall(waId, opaqueData = null) {
    const body = { wa_id: waId };
    if (opaqueData) body.opaque_data = opaqueData;
    return this._request('POST', '/voice/call/initiate', body);
  }

  acceptIncomingCall(callId) {
    return this._request('POST', `/voice/call/${encodeURIComponent(callId)}/accept-incoming`);
  }

  terminateCall(callId) {
    return this._request('POST', `/voice/call/${encodeURIComponent(callId)}/terminate`);
  }

  getCallStatus(callId) {
    return this._request('GET', `/voice/call/${encodeURIComponent(callId)}/status`);
  }

  getActiveCalls() {
    return this._request('GET', '/voice/calls/active').then((data) => {
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.calls)) return data.calls;
      return [];
    });
  }

  getCallHistory(page = 1, limit = 20) {
    return this._request('GET', '/voice/calls/history', null, { page, limit });
  }

  // ─── Calling enable (consumer API — wraps admin enable server-side) ─────────

  /**
   * Enable WhatsApp calling for the account identified by hash credentials.
   * Calls POST /voice/calling/enable on the WA Voice consumer API.
   * When using Spext, baseUrl is voice_api_base_url from GET /wa-calling/config
   * (proxied as /wa-calling/voice/calling/enable).
   */
  enableCalling(options = {}) {
    return this._request('POST', '/voice/calling/enable', options);
  }

  // ─── Agent WebRTC transport (browser) ───────────────────────────────────

  createAgentTransport(callId) {
    return this._request('POST', `/voice/call/${encodeURIComponent(callId)}/agent-transport`);
  }

  connectAgentTransport(callId, dtlsParameters) {
    return this._request('POST', `/voice/call/${encodeURIComponent(callId)}/agent-connect`, {
      dtls_parameters: dtlsParameters,
    });
  }

  produceAgentAudio(callId, rtpParameters) {
    return this._request('POST', `/voice/call/${encodeURIComponent(callId)}/agent-produce`, {
      rtp_parameters: rtpParameters,
    });
  }

  createAgentRecvTransport(callId) {
    return this._request('POST', `/voice/call/${encodeURIComponent(callId)}/agent-recv-transport`);
  }

  connectAgentRecvTransport(callId, dtlsParameters) {
    return this._request('POST', `/voice/call/${encodeURIComponent(callId)}/agent-recv-connect`, {
      dtls_parameters: dtlsParameters,
    });
  }

  consumeAgentAudio(callId, rtpCapabilities) {
    return this._request('POST', `/voice/call/${encodeURIComponent(callId)}/agent-consume`, {
      rtp_capabilities: rtpCapabilities,
    });
  }
}
