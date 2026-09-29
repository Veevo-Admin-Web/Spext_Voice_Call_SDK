/**
 * WebSocket connection manager for agent real-time call events.
 * Connects to /ws/agents and dispatches typed events to listeners.
 */
import {
  DEFAULT_WS_PATH,
  DEFAULT_WS_RECONNECT_MAX_MS,
  DEFAULT_WS_HEARTBEAT_MS,
  DEFAULT_WS_HEARTBEAT_TIMEOUT_MS,
  WS_EVENTS,
} from '../constants.js';

const AUTH_RETRY_MS = 2500;
const AUTH_TIMEOUT_MS = 20000;

export class AgentWebSocket {
  /**
   * @param {object} config
   * @param {string} config.wsUrl - Full WebSocket URL (wss://host/ws/agents)
   * @param {string|number} [config.accountId] - optional; resolved from hash via REST when omitted
   * @param {string} config.agentId
   * @param {boolean} [config.autoReconnect=true]
   * @param {number} [config.reconnectMaxMs]
   * @param {number} [config.heartbeatMs]
   */
  constructor({
    wsUrl,
    accountId = null,
    agentId,
    autoReconnect = true,
    reconnectMaxMs = DEFAULT_WS_RECONNECT_MAX_MS,
    heartbeatMs = DEFAULT_WS_HEARTBEAT_MS,
  }) {
    this.wsUrl = wsUrl;
    this.accountId = this._normalizeAccountId(accountId);
    this.agentId = agentId;
    this.autoReconnect = autoReconnect;
    this.reconnectMaxMs = reconnectMaxMs;
    this.heartbeatMs = heartbeatMs;

    this._ws = null;
    this._listeners = new Map();
    this._retryCount = 0;
    this._retryTimer = null;
    this._authRetryTimer = null;
    this._authTimeoutTimer = null;
    this._heartbeatTimer = null;
    this._heartbeatTimeoutTimer = null;
    this._intentionalClose = false;
    this.connectionState = 'disconnected';
    this._connectPromise = null;
    this._connectResolve = null;
    this._connectReject = null;
  }

  /**
   * Build wsUrl from HTTP base URL.
   */
  static buildWsUrl(baseUrl, path = DEFAULT_WS_PATH) {
    const parsed = new URL(baseUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.host}${path}`;
  }

  on(eventType, callback) {
    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }
    this._listeners.get(eventType).add(callback);
    return () => this.off(eventType, callback);
  }

  off(eventType, callback) {
    const set = this._listeners.get(eventType);
    if (set) set.delete(callback);
  }

  _emit(eventType, data) {
    const set = this._listeners.get(eventType);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(data);
      } catch (err) {
        console.error(`AgentWebSocket listener error [${eventType}]:`, err);
      }
    }
  }

  _clearAuthTimers() {
    clearTimeout(this._authRetryTimer);
    clearTimeout(this._authTimeoutTimer);
    this._authRetryTimer = null;
    this._authTimeoutTimer = null;
  }

  _rejectConnectPromise(error) {
    if (!this._connectReject) return;
    const reject = this._connectReject;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectPromise = null;
    reject(error);
  }

  _resolveConnectPromise(msg) {
    if (!this._connectResolve) return;
    const resolve = this._connectResolve;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectPromise = null;
    resolve(msg);
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
    clearTimeout(this._heartbeatTimeoutTimer);
    this._heartbeatTimer = null;
    this._heartbeatTimeoutTimer = null;
  }

  _resetHeartbeatWatchdog(ws) {
    clearTimeout(this._heartbeatTimeoutTimer);
    this._heartbeatTimeoutTimer = setTimeout(() => {
      if (this.connectionState === 'connected' && ws.readyState === WebSocket.OPEN) {
        console.warn('AgentWebSocket: heartbeat timeout — reconnecting');
        this._closeSocketSilently(ws);
      }
    }, DEFAULT_WS_HEARTBEAT_TIMEOUT_MS);
  }

  _startHeartbeat(ws) {
    this._stopHeartbeat();
    this._resetHeartbeatWatchdog(ws);
    this._heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
      } catch {
        this._closeSocketSilently(ws);
      }
    }, this.heartbeatMs);
  }

  _normalizeAccountId(accountId) {
    const n = Number(accountId);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  setAccountId(accountId) {
    this.accountId = this._normalizeAccountId(accountId);
  }

  hasValidAccountId() {
    return this.accountId != null;
  }

  _sendAuth(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!this.hasValidAccountId()) return;
    ws.send(JSON.stringify({
      type: 'AUTH',
      agent_id: this.agentId,
      account_id: this.accountId,
    }));
  }

  _scheduleAuthRetry(ws) {
    clearTimeout(this._authRetryTimer);
    this._authRetryTimer = setTimeout(() => {
      if (this.connectionState === 'connecting' && ws.readyState === WebSocket.OPEN) {
        this._sendAuth(ws);
        this._scheduleAuthRetry(ws);
      }
    }, AUTH_RETRY_MS);
  }

  _parseMessageText(data) {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(data);
    }
    return String(data ?? '');
  }

  _handleAuthOk(msg, ws) {
    if (this._ws !== ws) return;
    this._clearAuthTimers();
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._retryCount = 0;
    this.connectionState = 'connected';
    this._startHeartbeat(ws);
    this._resolveConnectPromise(msg);
    this._emit('connected', msg);
  }

  _closeSocketSilently(ws) {
    if (!ws) return;
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Open the socket and authenticate. Resolves with the AUTH_OK payload when ready.
   * @returns {Promise<object>}
   */
  connect() {
    if (!this.hasValidAccountId()) {
      return Promise.reject(
        new Error('AgentWebSocket: account_id is required before connect — resolve from hash via VoiceAgentSDK.connect()')
      );
    }

    if (this._ws?.readyState === WebSocket.OPEN && this.connectionState === 'connected') {
      return Promise.resolve({ type: 'AUTH_OK', agent_id: this.agentId });
    }

    if (this._connectPromise) {
      return this._connectPromise;
    }

    this._connectPromise = new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      if (this._ws) {
        const live = this._ws.readyState;
        if (live === WebSocket.CONNECTING || live === WebSocket.OPEN) {
          this._closeSocketSilently(this._ws);
        }
      }

      this._intentionalClose = false;
      this._clearAuthTimers();
      this._stopHeartbeat();
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
      this.connectionState = 'connecting';

      const ws = new WebSocket(this.wsUrl);
      this._ws = ws;

      ws.onopen = () => {
        if (this._ws !== ws) return;
        this._sendAuth(ws);
        this._scheduleAuthRetry(ws);

        this._authTimeoutTimer = setTimeout(() => {
          if (this._ws === ws && this.connectionState === 'connecting') {
            console.warn('AgentWebSocket: AUTH timeout — closing socket');
            this._rejectConnectPromise(new Error('AgentWebSocket: AUTH timeout'));
            this._closeSocketSilently(ws);
          }
        }, AUTH_TIMEOUT_MS);
      };

      ws.onmessage = (event) => {
        if (this._ws !== ws) return;

        const raw = this._parseMessageText(event.data);
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          if (raw.toUpperCase().includes('AUTH_OK')) {
            this._handleAuthOk({ type: 'AUTH_OK' }, ws);
          }
          return;
        }

        const msgType = String(msg.type || '').toUpperCase();

        if (msgType === 'PONG') {
          if (this.connectionState === 'connected') {
            this._resetHeartbeatWatchdog(ws);
          }
          return;
        }

        if (msgType === WS_EVENTS.AUTH_OK || msgType === 'AUTH_OK') {
          this._handleAuthOk(msg, ws);
          return;
        }

        if (msgType === 'AUTH_FAIL') {
          console.error('AgentWebSocket: AUTH_FAIL', msg.reason || msg);
          this._rejectConnectPromise(new Error(`AgentWebSocket: AUTH_FAIL — ${msg.reason || 'unknown'}`));
          this._closeSocketSilently(ws);
          return;
        }

        const emitType = ['AUTH_OK', 'AUTH_FAIL', 'PONG'].includes(msgType)
          ? msgType
          : String(msg.type || '').toLowerCase();

        this._emit(emitType, msg);
        this._emit('*', msg);
      };

      ws.onclose = () => {
        if (this._ws !== ws) return;

        const was_connecting = this.connectionState === 'connecting';
        this._clearAuthTimers();
        this._stopHeartbeat();
        this.connectionState = 'disconnected';
        this._ws = null;

        if (was_connecting) {
          this._rejectConnectPromise(new Error('AgentWebSocket: connection closed before AUTH completed'));
        }

        this._emit('disconnected', {});

        if (this.autoReconnect && !this._intentionalClose) {
          this._scheduleReconnect();
        }
      };

      ws.onerror = () => {
        if (this._ws !== ws) return;
        this._rejectConnectPromise(new Error('AgentWebSocket: WebSocket error during connect'));
        this._closeSocketSilently(ws);
      };
    });

    return this._connectPromise;
  }

  _scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this._retryCount, this.reconnectMaxMs);
    this._retryCount += 1;
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.warn('AgentWebSocket: auto-reconnect failed:', err?.message || err);
      });
    }, delay);
  }

  disconnect() {
    this._intentionalClose = true;
    this._clearAuthTimers();
    this._stopHeartbeat();
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._connectResolve = null;
    this._connectReject = null;
    this._connectPromise = null;
    this._closeSocketSilently(this._ws);
    this._ws = null;
    this.connectionState = 'disconnected';
  }

  get isConnected() {
    return this.connectionState === 'connected';
  }

  getConnectionState() {
    return this.connectionState;
  }
}
