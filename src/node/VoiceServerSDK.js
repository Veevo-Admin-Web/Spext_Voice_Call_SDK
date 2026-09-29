/**
 * High-level server-side SDK for backend integrations.
 * Handles settings, permissions, call orchestration, and calling enable.
 * Does NOT include WebRTC — agent media is browser-only.
 */
import { VoiceApiClient } from '../VoiceApiClient.js';

export class VoiceServerSDK {
  /**
   * @param {object} config
   * @param {string} config.baseUrl - Voice consumer API base URL (from GET /wa-calling/config)
   * @param {number|string} [config.accountId] - optional; resolved from hash when omitted
   * @param {string} config.hashKey
   * @param {typeof fetch} [config.fetchImpl]
   */
  constructor(config) {
    this.api = new VoiceApiClient({
      baseUrl: config.baseUrl,
      accountId: config.accountId,
      hashKey: config.hashKey,
      fetchImpl: config.fetchImpl,
    });
  }

  setCredentials(accountId, hashKey) {
    this.api.setCredentials(accountId, hashKey);
  }

  // ─── Settings ───────────────────────────────────────────────────────────

  async getCallSettings() {
    const data = await this.api.getSettings();
    return data.settings ?? data;
  }

  async updateCallSettings(patch) {
    return this.api.updateSettings(patch);
  }

  // ─── Permissions ────────────────────────────────────────────────────────

  async getCallPermissionStatus(waId) {
    return this.api.getPermissionStatus(waId);
  }

  /**
   * Returns current call permission status for a contact.
   * Outbound calls still require APPROVED permission (granted via WhatsApp).
   */
  async ensureCallPermission(waId) {
    const permission = await this.api.getPermissionStatus(waId);
    return { status: permission.status, permission };
  }

  // ─── Calls ──────────────────────────────────────────────────────────────

  /**
   * Initiate outbound call. Returns temp call_id until Meta connect webhook remaps it.
   * Agent browser must handle WebRTC via VoiceAgentSDK.
   */
  async initiateOutboundCall(waId, opaqueData = null) {
    return this.api.initiateCall(waId, opaqueData);
  }

  async terminateCall(callId) {
    return this.api.terminateCall(callId);
  }

  async getCallStatus(callId) {
    return this.api.getCallStatus(callId);
  }

  async getActiveCalls() {
    const data = await this.api.getActiveCalls();
    return data.calls ?? data;
  }

  async getCallHistory(page = 1, limit = 20) {
    const data = await this.api.getCallHistory(page, limit);
    return data.calls ?? data;
  }

  /**
   * Poll until call reaches target status or timeout.
   */
  async waitForCallStatus(callId, targetStatus, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.api.getCallStatus(callId);
      if (status.status === targetStatus) return status;
      if (status.status === 'TERMINATED') {
        return status;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Call ${callId} did not reach status ${targetStatus} within ${timeoutMs}ms`);
  }

  // ─── Calling enable (consumer API) ──────────────────────────────────────

  /**
   * Enable WhatsApp calling for the account tied to the configured hash.
   * Requires baseUrl from GET /wa-calling/config (voice_api_base_url).
   * accountId is optional when the hash alone resolves the account.
   */
  async enableCallingForAccount(accountId, options = {}) {
    let resolvedAccountId = accountId;
    let enableOptions = options;

    if (
      arguments.length === 1 &&
      accountId != null &&
      typeof accountId === 'object' &&
      !Array.isArray(accountId)
    ) {
      enableOptions = accountId;
      resolvedAccountId = null;
    }

    if (resolvedAccountId != null && String(resolvedAccountId).trim() !== '') {
      this.api.setCredentials(resolvedAccountId, this.api.hashKey);
    }
    return this.api.enableCalling(enableOptions);
  }
}
