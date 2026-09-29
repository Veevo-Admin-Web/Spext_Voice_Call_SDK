/**
 * High-level browser SDK — combines REST, WebSocket, and WebRTC for agent UIs.
 */
import { VoiceApiClient } from '../VoiceApiClient.js';
import { AgentWebSocket } from './AgentWebSocket.js';
import { AgentMedia } from './AgentMedia.js';
import {
  CALL_DIRECTION,
  CALL_STATUS,
  DEFAULT_STATUS_POLL_MS,
  FAST_STATUS_POLL_MS,
  WS_EVENTS,
} from '../constants.js';

export class VoiceAgentSDK {
  /**
   * @param {object} config
   * @param {string} config.baseUrl - Voice consumer API base URL
   * @param {number|string} [config.accountId] - optional; resolved from hash when omitted
   * @param {string} config.hashKey
   * @param {string} config.agentId - Unique agent identifier for WebSocket routing
   * @param {string} [config.wsUrl] - Override WebSocket URL (default derived from baseUrl)
   * @param {boolean} [config.autoConnect=true] - Connect WebSocket on construction
   * @param {number} [config.statusPollMs] - Fallback polling interval when WS is slow
   */
  constructor(config) {
    this.config = config;
    this.api = new VoiceApiClient({
      baseUrl: config.baseUrl,
      accountId: config.accountId,
      hashKey: config.hashKey,
    });

    const wsUrl = config.wsUrl || AgentWebSocket.buildWsUrl(config.baseUrl);
    this.ws = new AgentWebSocket({
      wsUrl,
      accountId: config.accountId,
      agentId: config.agentId,
      autoReconnect: config.autoReconnect !== false,
    });

    this.media = new AgentMedia(this.api, config.mediaOptions);
    this._eventHandlers = new Map();
    this._activeCall = null;
    this._incomingCalls = [];
    this._statusPollTimer = null;
    this._mediaSetupPending = null;
    this._mediaRecvPending = null;
    this._statusPollMs = config.statusPollMs ?? DEFAULT_STATUS_POLL_MS;
    this._fastStatusPollMs = config.fastStatusPollMs ?? FAST_STATUS_POLL_MS;
    this._fastPollTimer = null;
    this._accountResolvePromise = null;
    this.resolvedAccountId = null;
    this._wsRecoverTimer = null;
    this._mediaRecoverInFlight = false;

    this.media.setSendTransportUnhealthyHandler((payload) => {
      this._handleSendTransportUnhealthy(payload);
    });

    this._bindWebSocketHandlers();

    if (config.autoConnect !== false) {
      this.connect().catch((err) => {
        console.error('VoiceAgentSDK: WebSocket connect failed:', err);
        this._emit('wsError', { error: err });
      });
    }
  }

  /**
   * Resolve account_id from hash when not supplied at construction.
   * Required for WebSocket AUTH; REST works with hash alone.
   */
  async _ensureAccountResolved() {
    if (this.resolvedAccountId) {
      return this.resolvedAccountId;
    }

    if (this.api.accountId) {
      this.resolvedAccountId = String(this.api.accountId);
      this.ws.setAccountId(this.resolvedAccountId);
      return this.resolvedAccountId;
    }

    if (!this._accountResolvePromise) {
      this._accountResolvePromise = this.api.getSettings()
        .then((data) => {
          const settings = data.settings ?? data;
          const accountId = data.account_id ?? settings?.account_id;
          if (!accountId) {
            throw new Error('Could not resolve account from API hash');
          }
          this.resolvedAccountId = String(accountId);
          this.api.setCredentials(this.resolvedAccountId, this.config.hashKey);
          this.ws.setAccountId(this.resolvedAccountId);
          return this.resolvedAccountId;
        })
        .finally(() => {
          this._accountResolvePromise = null;
        });
    }

    return this._accountResolvePromise;
  }

  on(event, handler) {
    if (!this._eventHandlers.has(event)) {
      this._eventHandlers.set(event, new Set());
    }
    this._eventHandlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this._eventHandlers.get(event);
    if (set) set.delete(handler);
  }

  _emit(event, data) {
    const set = this._eventHandlers.get(event);
    if (set) {
      for (const handler of set) {
        try { handler(data); } catch (e) { console.error(`VoiceAgentSDK [${event}]:`, e); }
      }
    }
  }

  _getWsEventHandlers() {
    return {
      [WS_EVENTS.INCOMING_CALL]: (data) => {
        if (this._incomingCalls.some((c) => c.call_id === data.call_id)) return;
        this._incomingCalls.push(data);
        this._emit('incomingCall', data);
      },
      [WS_EVENTS.CALL_DIALING]: (data) => this._handleCallUpdate('dialing', data),
      [WS_EVENTS.CALL_RINGING]: (data) => this._handleCallUpdate('ringing', data),
      [WS_EVENTS.CALL_ACCEPTED]: (data) => this._handleCallUpdate('accepted', data),
      [WS_EVENTS.CALL_CONNECTED]: (data) => this._handleCallUpdate('connected', data),
      [WS_EVENTS.CALL_REJECTED]: (data) => this._handleCallEnd('rejected', data),
      [WS_EVENTS.CALL_TERMINATED]: (data) => this._handleCallEnd('terminated', data),
      [WS_EVENTS.CALL_MEDIA_WARNING]: (data) => {
        if (this._matchesActiveCall(data) || this._shouldRemapOutboundCall(data)) {
          this._syncCallIdsFromEvent(data);
          this._pollCallStatusNow();
          this._emit('mediaWarning', {
            call_id: data.call_id,
            code:    data.code || 'BIC_SDP_DELAYED',
            message: data.message || 'Call audio is still connecting. Please wait a moment.',
          });
        }
      },
      [WS_EVENTS.PERMISSION_APPROVED]: (data) => this._emit('permissionApproved', data),
      [WS_EVENTS.PERMISSION_DECLINED]: (data) => this._emit('permissionDeclined', data),
    };
  }

  _dispatchWsEvent(eventType, data) {
    const handler = this._getWsEventHandlers()[eventType];
    if (handler) handler(data);
  }

  /**
   * Replay calls/events included in AUTH_OK before the socket is considered ready.
   */
  _processAuthPending(authMsg) {
    if (!authMsg) return;

    const pendingIncoming = authMsg.pending_incoming_calls;
    if (Array.isArray(pendingIncoming)) {
      for (const call of pendingIncoming) {
        if (!call?.call_id) continue;
        this._dispatchWsEvent(WS_EVENTS.INCOMING_CALL, call);
      }
    }

    const pendingEvents = authMsg.pending_events;
    if (Array.isArray(pendingEvents)) {
      for (const entry of pendingEvents) {
        const eventType = entry?.event_type;
        const payload   = entry?.payload;
        if (!eventType || !payload) continue;
        this._dispatchWsEvent(eventType, payload);
      }
    }
  }

  _bindWebSocketHandlers() {
    const wsMap = this._getWsEventHandlers();

    for (const [type, handler] of Object.entries(wsMap)) {
      this.ws.on(type, handler);
    }

    this.ws.on('connected', (authMsg) => {
      this._processAuthPending(authMsg);
      this._emit('wsConnected', {
        pending_incoming: authMsg?.pending_incoming_calls?.length || 0,
        pending_events:   authMsg?.pending_events?.length || 0,
      });
      this._scheduleMediaRecoveryAfterWsReconnect();
      this._syncActiveIncomingCalls().catch((err) => {
        console.warn('VoiceAgentSDK: active call sync after WS connect failed:', err);
      });
    });
    this.ws.on('disconnected', () => this._emit('wsDisconnected', {}));
  }

  _scheduleMediaRecoveryAfterWsReconnect() {
    clearTimeout(this._wsRecoverTimer);
    this._wsRecoverTimer = setTimeout(() => {
      this._recoverActiveCallAfterWsReconnect().catch((err) => {
        console.warn('VoiceAgentSDK: media recovery after WS reconnect failed:', err);
      });
    }, 350);
  }

  async _syncActiveIncomingCalls() {
    await this._ensureAccountResolved();

    const calls = await this.api.getActiveCalls();
    if (!Array.isArray(calls) || !calls.length) return;

    const pending_uic = new Set([CALL_STATUS.INITIATED, CALL_STATUS.RINGING]);

    for (const session of calls) {
      if (session.direction !== CALL_DIRECTION.USER_INITIATED) continue;
      if (!pending_uic.has(String(session.status || '').toUpperCase())) continue;
      if (!session.call_id) continue;
      if (this._incomingCalls.some((c) => c.call_id === session.call_id)) continue;
      if (this._activeCall?.call_id === session.call_id) continue;

      const payload = {
        call_id:     session.call_id,
        direction:   session.direction,
        wa_id:       session.wa_id,
        session,
        sync_replay: true,
      };

      this._incomingCalls.push(payload);
      this._emit('incomingCall', payload);
    }
  }

  async _recoverActiveCallAfterWsReconnect() {
    const call = this._activeCall;
    if (!call?.call_id) return;

    try {
      const data = await this.api.getCallStatus(call.call_id);
      if (data.status === CALL_STATUS.TERMINATED) {
        this._handleCallEnd('terminated', {
          call_id: data.call_id || call.call_id,
          temp_call_id: data.temp_call_id,
          terminate_status: data.terminate_status,
          duration_sec: data.duration_sec,
        });
        return;
      }
      this._applyPolledStatus(call, data);
    } catch {
      /* status poll may fail on temp id — still attempt media recovery */
    }

    await this._recoverCallMedia(call, 'ws_reconnect');
  }

  _handleSendTransportUnhealthy({ state, callId }) {
    const call = this._activeCall;
    if (!call?.call_id) return;
    if (callId && call.call_id !== callId) return;
    if (call.status !== CALL_STATUS.ACTIVE && call.status !== CALL_STATUS.CONNECTING) return;

    console.warn(`VoiceAgentSDK: send transport unhealthy (${state}) — recovering media for call ${call.call_id}`);
    this._recoverCallMedia(call, `transport_${state}`).catch((err) => {
      console.warn('VoiceAgentSDK: transport recovery failed:', err);
    });
  }

  async _recoverCallMedia(call, reason = 'recover') {
    if (!call?.call_id || this._mediaRecoverInFlight) return;
    if (call.status !== CALL_STATUS.ACTIVE && call.status !== CALL_STATUS.CONNECTING) return;

    this._mediaRecoverInFlight = true;
    this._mediaSetupPending = null;
    this._mediaRecvPending = null;

    try {
      if (this.media.needsMediaRecovery()) {
        await this.media.teardown({ terminateRemote: false, releaseMic: false });
        this._maybeSetupMedia();
        return;
      }

      if (!this.media.isMediaConnected()) {
        await this.media.teardown({ terminateRemote: false, releaseMic: false });
        this._maybeSetupMedia();
      }
    } finally {
      this._mediaRecoverInFlight = false;
    }
  }

  _matchesActiveCall(data) {
    if (!this._activeCall || !data) return false;

    const knownIds = new Set(
      [this._activeCall.call_id, this._activeCall.temp_call_id].filter(Boolean)
    );
    if (data.call_id && knownIds.has(data.call_id)) return true;
    if (data.temp_call_id && knownIds.has(data.temp_call_id)) return true;

    if (
      this._activeCall.call_id &&
      data.temp_call_id &&
      this._activeCall.call_id === data.temp_call_id
    ) {
      return true;
    }
    if (
      this._activeCall.temp_call_id &&
      data.call_id &&
      this._activeCall.temp_call_id === data.call_id
    ) {
      return true;
    }

    // Optimistic outbound dial UI (no server call_id yet) — match WS by callee.
    if (
      this._activeCall.direction === CALL_DIRECTION.BUSINESS_INITIATED &&
      !this._activeCall.call_id &&
      this._activeCall.status === CALL_STATUS.INITIATING &&
      this._activeCall.wa_id &&
      data.wa_id === this._activeCall.wa_id
    ) {
      return true;
    }

    return false;
  }

  _shouldRemapOutboundCall(data) {
    const call = this._activeCall;
    if (!call || call.direction !== CALL_DIRECTION.BUSINESS_INITIATED || !data?.call_id) {
      return false;
    }

    const inFlight = [
      CALL_STATUS.INITIATING,
      CALL_STATUS.INITIATED,
      CALL_STATUS.RINGING,
      CALL_STATUS.CONNECTING,
      CALL_STATUS.ACTIVE,
    ].includes(call.status);
    if (!inFlight) return false;

    if (this._matchesActiveCall(data)) return true;

    if (!call.call_id && call.wa_id && data.wa_id === call.wa_id) return true;

    return !!(
      call.call_id?.startsWith('temp_') ||
      call.temp_call_id ||
      !call.call_id
    );
  }

  _syncCallIdsFromEvent(data) {
    if (!this._activeCall || !data) return;

    if (data.temp_call_id) {
      this._activeCall.temp_call_id = data.temp_call_id;
    }
    if (data.call_id && data.call_id !== this._activeCall.call_id) {
      this._remapActiveCallId(data.call_id);
    }
  }

  _markMetaSdpReady(call) {
    if (call) call._metaSdpReady = true;
  }

  _outboundSdpReady(call) {
    return !!call?._metaSdpReady;
  }

  /**
   * Outbound recv can start once callee audio exists on the server (meta_audio_ready)
   * or after answer (ACTIVE), or while CONNECTING if agent send path is already up.
   */
  _shouldStartOutboundRecv(call, pollData = {}) {
    if (!call) return false;
    if (call.direction !== CALL_DIRECTION.BUSINESS_INITIATED) {
      return call.status === CALL_STATUS.ACTIVE;
    }
    if (call.status === CALL_STATUS.ACTIVE) return true;
    if (pollData.meta_audio_ready === true) return true;
    if (call.startedAt) return true;
    if (
      this._outboundSdpReady(call) &&
      this.media.isSendPathHealthy() &&
      (call.status === CALL_STATUS.RINGING || call.status === CALL_STATUS.CONNECTING)
    ) {
      return true;
    }
    return false;
  }

  /**
   * UI label helper — CONNECTING before answer is still "ringing" for outbound BIC.
   */
  getDisplayStatus(call) {
    if (!call) return null;
    if (
      call.direction === CALL_DIRECTION.BUSINESS_INITIATED &&
      call.status === CALL_STATUS.CONNECTING &&
      !call.startedAt
    ) {
      return CALL_STATUS.RINGING;
    }
    return call.status;
  }

  _remapActiveCallId(newCallId) {
    if (!this._activeCall || !newCallId || this._activeCall.call_id === newCallId) {
      return false;
    }

    const oldCallId = this._activeCall.call_id;
    if (oldCallId?.startsWith('temp_') && oldCallId !== newCallId) {
      this._activeCall.temp_call_id = this._activeCall.temp_call_id || oldCallId;
    }
    this._activeCall.call_id = newCallId;

    if (this._mediaSetupPending?.startsWith(`${oldCallId}:`)) {
      this._mediaSetupPending = this._mediaSetupPending.replace(oldCallId, newCallId);
    }
    if (this._mediaRecvPending?.startsWith(`${oldCallId}:`)) {
      this._mediaRecvPending = this._mediaRecvPending.replace(oldCallId, newCallId);
    }

    if (this.media._activeCallId === oldCallId) {
      this.media._activeCallId = newCallId;
    }

    return true;
  }

  _handleCallUpdate(phase, data) {
    if (
      !this._activeCall &&
      phase === 'ringing' &&
      data?.call_id &&
      (data.direction === CALL_DIRECTION.USER_INITIATED || !data.direction)
    ) {
      if (!this._incomingCalls.some((c) => c.call_id === data.call_id)) {
        const incoming = {
          call_id:   data.call_id,
          wa_id:     data.wa_id || null,
          direction: CALL_DIRECTION.USER_INITIATED,
          session:   data.session || null,
        };
        this._incomingCalls.push(incoming);
        this._emit('incomingCall', incoming);
      }
      return;
    }

    if (!this._activeCall && phase !== 'dialing') return;

    if (!this._activeCall && phase === 'dialing') {
      this._activeCall = {
        call_id: data.call_id,
        temp_call_id: data.temp_call_id || null,
        wa_id: data.wa_id || null,
        direction: CALL_DIRECTION.BUSINESS_INITIATED,
        status: CALL_STATUS.INITIATED,
        startedAt: null,
        dialStartedAt: Date.now(),
        _metaSdpReady: false,
      };
      this._emit('callStateChanged', { ...this._activeCall, phase });
      this._startStatusPolling();
      return;
    }

    if (!this._activeCall) return;

    if (!this._matchesActiveCall(data)) {
      if (!this._shouldRemapOutboundCall(data)) return;
    }
    this._syncCallIdsFromEvent(data);

    if (phase === 'dialing') {
      if (data.wa_id) {
        this._activeCall.wa_id = data.wa_id;
      }
      this._activeCall.status = CALL_STATUS.INITIATED;
    } else if (phase === 'ringing') {
      this._activeCall.status = CALL_STATUS.RINGING;
    } else if (phase === 'accepted') {
      this._activeCall.status = CALL_STATUS.ACTIVE;
      this._activeCall.startedAt = this._activeCall.startedAt || Date.now();
      if (this._activeCall.direction === CALL_DIRECTION.BUSINESS_INITIATED) {
        if (data.meta_media_ready !== false) {
          this._markMetaSdpReady(this._activeCall);
        }
        this._stopFastMetaSdpPoll();
        this._pollCallStatusNow();
      }
      this._maybeSetupMedia();
      this._ensureRecvMedia(this._activeCall);
    } else if (phase === 'connected') {
      const isOutbound = this._activeCall.direction === CALL_DIRECTION.BUSINESS_INITIATED;
      if (isOutbound) {
        // Server emits call_connected only after Meta SDP is applied.
        this._markMetaSdpReady(this._activeCall);
        this._stopFastMetaSdpPoll();
        if (this._activeCall.status !== CALL_STATUS.ACTIVE) {
          this._activeCall.status = CALL_STATUS.RINGING;
        }
      } else {
        this._activeCall.status = CALL_STATUS.ACTIVE;
        this._activeCall.startedAt = this._activeCall.startedAt || Date.now();
      }
      if (!isOutbound || this._outboundSdpReady(this._activeCall)) {
        this._maybeSetupMedia();
      }
    }

    this._emit('callStateChanged', {
      ...this._activeCall,
      phase,
      displayStatus: this.getDisplayStatus(this._activeCall),
    });
    this._startStatusPolling();
  }

  _handleCallEnd(reason, data) {
    if (this._matchesActiveCall(data) || this._incomingCalls.some((c) => c.call_id === data.call_id)) {
      this._incomingCalls = this._incomingCalls.filter((c) => c.call_id !== data.call_id);
      this._stopStatusPolling();
      this._mediaSetupPending = null;
      this._mediaRecvPending = null;
      this.media.teardown();

      const ended = {
        call_id: data.call_id,
        reason,
        terminate_status: data.terminate_status,
        duration_sec: data.duration_sec,
      };

      if (this._matchesActiveCall(data)) {
        this._activeCall = null;
      }

      this._emit('callEnded', ended);
    }
  }

  _maybeSetupMedia() {
    const call = this._activeCall;
    if (!call) return;

    const isOutbound = call.direction === CALL_DIRECTION.BUSINESS_INITIATED;

    if (isOutbound) {
      // BIC: wait for Meta SDP (call_connected / CONNECTING) before any WebRTC setup
      if (!this._outboundSdpReady(call)) return;

      if (call.status === CALL_STATUS.CONNECTING
        || call.status === CALL_STATUS.ACTIVE
        || call.status === CALL_STATUS.RINGING) {
        this._ensureSendMedia(call);
      }
      return;
    }

    if (call.status === CALL_STATUS.ACTIVE) {
      this._ensureFullMedia(call);
    }
  }

  _ensureSendMedia(call, attempt = 1) {
    const token = `${call.call_id}:send`;
    if (this._mediaSetupPending === token) return;

    this._mediaSetupPending = token;
    this.media.setupForCall(call.call_id, { enableRecv: false })
      .then(() => {
        this._mediaSetupPending = null;
        this._emit('mediaSendReady', { call_id: call.call_id });
        this._emit('micReady', { call_id: call.call_id });
        if (
          this._activeCall?.call_id === call.call_id &&
          this._outboundSdpReady(call) &&
          this._shouldStartOutboundRecv(this._activeCall)
        ) {
          this._ensureRecvMedia(call);
        }
      })
      .catch(async (err) => {
        this._mediaSetupPending = null;
        await this.media._resetSendPath().catch(() => {});

        const maxAttempts = 3;
        if (attempt < maxAttempts && this._activeCall?.call_id === call.call_id) {
          setTimeout(() => {
            if (this._activeCall?.call_id === call.call_id) {
              this._ensureSendMedia(call, attempt + 1);
            }
          }, 1500 * attempt);
          return;
        }

        this._emit('mediaError', { call_id: call.call_id, error: err });
      });
  }

  _ensureRecvMedia(call, attempt = 1) {
    const token = `${call.call_id}:recv`;
    if (this._mediaRecvPending === token && attempt === 1) return;

    this._mediaRecvPending = token;
    this.media.setupRemoteAudio(call.call_id)
      .then(() => {
        this._mediaRecvPending = null;
        this._emit('mediaReady', { call_id: call.call_id });
      })
      .catch((err) => {
        const maxAttempts = 8;
        const retryable = attempt < maxAttempts
          && this._activeCall?.call_id === call.call_id
          && (
            this._activeCall.status === CALL_STATUS.CONNECTING
            || this._activeCall.status === CALL_STATUS.ACTIVE
            || (
              this._activeCall.status === CALL_STATUS.RINGING
              && this._activeCall.direction === CALL_DIRECTION.BUSINESS_INITIATED
              && this._outboundSdpReady(this._activeCall)
            )
          );

        if (retryable) {
          this._mediaRecvPending = null;
          const retry_delay_ms = attempt <= 4 ? 800 : 2000;
          setTimeout(() => {
            if (this._activeCall?.call_id === call.call_id) {
              this._ensureRecvMedia(call, attempt + 1);
            }
          }, retry_delay_ms);
          return;
        }

        this._mediaRecvPending = null;
        this._emit('mediaError', { call_id: call.call_id, error: err });
      });
  }

  _ensureFullMedia(call, attempt = 1) {
    const token = `${call.call_id}:full`;
    if (this._mediaSetupPending === token) return;

    this._mediaSetupPending = token;
    this.media.setupForCall(call.call_id)
      .then(() => {
        this._mediaSetupPending = null;
        this._emit('mediaReady', { call_id: call.call_id });
      })
      .catch(async (err) => {
        this._mediaSetupPending = null;

        const transport_state = this.media._sendTransport?.connectionState;
        const keep_send_path = transport_state === 'connecting' || transport_state === 'connected';
        if (keep_send_path) {
          await this.media._resetRecvPath().catch(() => {});
        } else {
          await this.media.teardown({ terminateRemote: false }).catch(() => {});
        }

        const maxAttempts = 5;
        if (attempt < maxAttempts && this._activeCall?.call_id === call.call_id) {
          const retry_delay_ms = attempt <= 3 ? 800 : 1500 * attempt;
          setTimeout(() => {
            if (this._activeCall?.call_id === call.call_id) {
              this._ensureFullMedia(call, attempt + 1);
            }
          }, retry_delay_ms);
          return;
        }

        this._emit('mediaError', { call_id: call.call_id, error: err });
      });
  }

  _applyOutboundMediaReady(call, data) {
    if (!call || call.direction !== CALL_DIRECTION.BUSINESS_INITIATED) return false;

    const media_ready = data.meta_media_ready === true;
    if (!media_ready && !this._outboundSdpReady(call)) {
      return false;
    }

    this._markMetaSdpReady(call);
    this._stopFastMetaSdpPoll();

    if (call.status !== CALL_STATUS.ACTIVE && (data.status === CALL_STATUS.CONNECTING || media_ready)) {
      if (call.direction === CALL_DIRECTION.BUSINESS_INITIATED && !call.startedAt) {
        if (call.status === CALL_STATUS.INITIATING || call.status === CALL_STATUS.INITIATED) {
          call.status = CALL_STATUS.RINGING;
        }
      } else {
        call.status = CALL_STATUS.CONNECTING;
      }
    }

    this._maybeSetupMedia();
    if (this._shouldStartOutboundRecv(call, data)) {
      this._ensureRecvMedia(call);
    }
    return true;
  }

  _applyPolledStatus(call, data) {
    let call_id_changed = false;
    if (data.temp_call_id) {
      call.temp_call_id = data.temp_call_id;
    }
    if (data.call_id && data.call_id !== call.call_id) {
      this._remapActiveCallId(data.call_id);
      call_id_changed = true;
    }

    if (!data.status || data.status === call.status) {
      let media_became_ready = false;
      if (data.meta_media_ready === true) {
        media_became_ready = this._applyOutboundMediaReady(call, data);
      }
      if (
        call.direction === CALL_DIRECTION.BUSINESS_INITIATED &&
        data.meta_audio_ready === true &&
        !call.startedAt
      ) {
        call.startedAt = Date.now();
        if (call.status === CALL_STATUS.RINGING) {
          call.status = CALL_STATUS.ACTIVE;
        }
        media_became_ready = true;
      }
      if (this._shouldStartOutboundRecv(call, data)) {
        this._ensureRecvMedia(call);
      }
      if (media_became_ready || call_id_changed) {
        this._emit('callStateChanged', {
          ...call,
          phase: 'status_poll',
          displayStatus: this.getDisplayStatus(call),
        });
      }
      return call_id_changed || media_became_ready;
    }

    const prev_status = call.status;
    const isOutbound = call.direction === CALL_DIRECTION.BUSINESS_INITIATED;

    if (data.status === CALL_STATUS.CONNECTING
      && isOutbound
      && !call.startedAt) {
      // Server CONNECTING = media leg ready; UI stays ringing until callee answers.
      call.status = CALL_STATUS.RINGING;
    } else {
      call.status = data.status;
    }

    if (data.meta_media_ready === true) {
      this._applyOutboundMediaReady(call, data);
    }

    if (
      isOutbound &&
      data.meta_audio_ready === true &&
      !call.startedAt
    ) {
      call.startedAt = Date.now();
      if (data.status === CALL_STATUS.CONNECTING || call.status === CALL_STATUS.RINGING) {
        call.status = CALL_STATUS.ACTIVE;
      }
      this._markMetaSdpReady(call);
    }

    if (data.status === CALL_STATUS.ACTIVE && !call.startedAt) {
      call.startedAt = Date.now();
    }

    if (
      data.status === CALL_STATUS.CONNECTING ||
      data.status === CALL_STATUS.RINGING ||
      data.status === CALL_STATUS.ACTIVE
    ) {
      if (!isOutbound || this._outboundSdpReady(call)) {
        this._maybeSetupMedia();
      } else if (
        isOutbound &&
        (data.status === CALL_STATUS.CONNECTING || data.status === CALL_STATUS.ACTIVE)
      ) {
        this._startFastMetaSdpPoll();
      }
      if (this._shouldStartOutboundRecv(call, data)) {
        this._ensureRecvMedia(call);
      }
    }

    const phase = data.status === CALL_STATUS.ACTIVE
      ? 'accepted'
      : data.status === CALL_STATUS.RINGING
        ? 'ringing'
        : data.status === CALL_STATUS.CONNECTING
          ? 'connected'
          : 'status_poll';

    this._emit('callStateChanged', {
      ...call,
      phase,
      displayStatus: this.getDisplayStatus(call),
    });
    return prev_status !== call.status || call_id_changed;
  }

  _pollCallStatusNow() {
    const call = this._activeCall;
    if (!call?.call_id) return;

    this.api.getCallStatus(call.call_id)
      .then((data) => {
        if (this._activeCall?.call_id === call.call_id || this._activeCall?.call_id === data.call_id) {
          this._applyPolledStatus(this._activeCall, data);
        }
      })
      .catch(() => {});
  }

  _startFastMetaSdpPoll() {
    if (this._fastPollTimer) return;

    this._fastPollTimer = setInterval(() => {
      const call = this._activeCall;
      if (!call?.call_id) {
        this._stopFastMetaSdpPoll();
        return;
      }

      if (this._outboundSdpReady(call)) {
        this._stopFastMetaSdpPoll();
        this._maybeSetupMedia();
        if (this._shouldStartOutboundRecv(call)) {
          this._ensureRecvMedia(call);
        }
        return;
      }

      this._pollCallStatusNow();
    }, this._fastStatusPollMs);
  }

  _stopFastMetaSdpPoll() {
    if (this._fastPollTimer) {
      clearInterval(this._fastPollTimer);
      this._fastPollTimer = null;
    }
  }

  _startStatusPolling() {
    if (this._statusPollTimer || !this._activeCall) return;

    this._statusPollTimer = setInterval(async () => {
      const call = this._activeCall;
      if (!call?.call_id) {
        return;
      }

      try {
        const data = await this.api.getCallStatus(call.call_id);

        if (data.status === CALL_STATUS.TERMINATED) {
          this._handleCallEnd('terminated', {
            call_id: data.call_id || call.call_id,
            temp_call_id: data.temp_call_id,
            terminate_status: data.terminate_status,
            duration_sec: data.duration_sec,
          });
          return;
        }

        const changed = this._applyPolledStatus(call, data);
        if (!changed) {
          /* status unchanged — _applyPolledStatus already emitted on call_id remap */
        }
      } catch {
        /* temp id may not be remapped yet — keep polling */
      }
    }, this._statusPollMs);
  }

  _stopStatusPolling() {
    this._stopFastMetaSdpPoll();
    if (this._statusPollTimer) {
      clearInterval(this._statusPollTimer);
      this._statusPollTimer = null;
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  async getSettings() {
    await this._ensureAccountResolved();
    const data = await this.api.getSettings();
    return data.settings ?? data;
  }

  async updateSettings(patch) {
    await this._ensureAccountResolved();
    return this.api.updateSettings(patch);
  }

  /**
   * Enable WhatsApp calling for the account tied to the configured hash.
   * Calls POST /voice/calling/enable on the consumer API (baseUrl from config).
   */
  async enableCalling(options = {}) {
    await this._ensureAccountResolved();
    return this.api.enableCalling(options);
  }

  async getPermissionStatus(waId) {
    await this._ensureAccountResolved();
    return this.api.getPermissionStatus(waId);
  }

  async dial(waId, opaqueData = null) {
    if (this._activeCall) {
      throw new Error('A call is already in progress');
    }

    // Mic must be acquired on the user click — before any network await.
    await this.media.primeMicrophone();
    this._emit('micReady', { wa_id: waId });
    await this.media.primePlayback();
    await this._ensureAccountResolved();

    // Optimistic UI only — do not invent a temp call_id; server temp ids differ and
    // would cause WS events (call_dialing / call_connected) to be dropped.
    this._activeCall = {
      call_id: null,
      temp_call_id: null,
      wa_id: waId,
      direction: CALL_DIRECTION.BUSINESS_INITIATED,
      status: CALL_STATUS.INITIATING,
      startedAt: null,
      dialStartedAt: Date.now(),
      _metaSdpReady: false,
    };
    this._emit('callStateChanged', { ...this._activeCall, phase: 'dialing' });

    let result;
    try {
      result = await this.api.initiateCall(waId, opaqueData);
    } catch (err) {
      this._stopStatusPolling();
      this._stopFastMetaSdpPoll();

      const failedId = result?.call_id
        || this._activeCall?.call_id
        || this._activeCall?.temp_call_id;
      if (failedId) {
        await this.api.terminateCall(failedId).catch(() => {});
      }

      await this.media.teardown({ terminateRemote: false }).catch(() => {});
      this._activeCall = null;
      this._emit('callEnded', {
        call_id: failedId || `temp_${Date.now()}`,
        reason: 'failed',
        terminate_status: 'FAILED',
        duration_sec: 0,
      });
      throw err;
    }

    const callId = result.call_id;
    if (!callId) {
      this._activeCall = null;
      throw new Error('Voice API did not return call_id');
    }

    this._activeCall.call_id = callId;
    this._activeCall.temp_call_id = result.temp_call_id || null;
    this._activeCall.status = CALL_STATUS.INITIATED;

    if (result.meta_media_ready) {
      this._applyOutboundMediaReady(this._activeCall, {
        meta_media_ready: true,
        status: CALL_STATUS.RINGING,
      });
    } else {
      this._startFastMetaSdpPoll();
    }

    this._emit('callStateChanged', {
      ...this._activeCall,
      phase: 'initiated',
      displayStatus: this.getDisplayStatus(this._activeCall),
    });
    this._startStatusPolling();
    return result;
  }

  async acceptIncoming(callId) {
    await this.media.primeMicrophone();
    this._emit('micReady', { call_id: callId });
    await this.media.primePlayback();
    await this._ensureAccountResolved();
    const acceptResult = await this.api.acceptIncomingCall(callId);

    const incoming = this._incomingCalls.find((c) => c.call_id === callId);
    this._incomingCalls = this._incomingCalls.filter((c) => c.call_id !== callId);

    this._activeCall = {
      call_id: callId,
      wa_id: incoming?.wa_id,
      direction: CALL_DIRECTION.USER_INITIATED,
      status: CALL_STATUS.ACTIVE,
      startedAt: Date.now(),
      _metaSdpReady: acceptResult?.meta_media_ready !== false,
    };

    this._maybeSetupMedia();
    this._emit('callStateChanged', { ...this._activeCall, phase: 'accepted' });
    this._startStatusPolling();
  }

  dismissIncoming(callId) {
    this._incomingCalls = this._incomingCalls.filter((c) => c.call_id !== callId);
    this._emit('incomingDismissed', { call_id: callId });
  }

  getIncomingCalls() {
    return [...this._incomingCalls];
  }

  getActiveCall() {
    return this._activeCall ? { ...this._activeCall } : null;
  }

  async hangup() {
    const call = this._activeCall;
    if (!call?.call_id) return;

    const callId = call.call_id;
    const startedAt = call.startedAt;

    try {
      await this.api.terminateCall(callId);
    } catch (err) {
      throw err;
    }

    this._stopStatusPolling();
    this._mediaSetupPending = null;
    this._mediaRecvPending = null;
    this.media.teardown();
    this._activeCall = null;

    this._emit('callEnded', {
      call_id: callId,
      reason: 'terminated',
      terminate_status: 'COMPLETED',
      duration_sec: startedAt
        ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
        : 0,
    });
  }

  async connect() {
    await this._ensureAccountResolved();
    const state = this.ws.getConnectionState?.() || this.ws.connectionState;
    if (state === 'connected') {
      return { type: 'AUTH_OK', agent_id: this.config.agentId };
    }
    return this.ws.connect();
  }

  getWsState() {
    return this.ws.getConnectionState?.() || this.ws.connectionState;
  }

  toggleMute() {
    const muted = this.media.toggleMute();
    this._emit('muteChanged', { muted });
    return muted;
  }

  /**
   * Re-request microphone access (user must click — e.g. after browser block during recovery).
   */
  async requestMicrophone() {
    const result = await this.media.primeMicrophone();
    this._emit('micReady', { call_id: this._activeCall?.call_id || null });
    if (this._activeCall?.call_id && this.media.needsMediaRecovery()) {
      this._maybeSetupMedia();
    }
    return result;
  }

  destroy() {
    clearTimeout(this._wsRecoverTimer);
    this._wsRecoverTimer = null;
    this._stopStatusPolling();
    this._stopFastMetaSdpPoll();
    this.ws.disconnect();
    this.media.teardown();
    this._activeCall = null;
    this._incomingCalls = [];
    this._eventHandlers.clear();
  }
}
