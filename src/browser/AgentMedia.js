/**
 * Browser WebRTC media layer — wraps mediasoup-client and voice transport APIs.
 * Requires peer dependency: mediasoup-client
 */

function _isPrivateIpv4(host_value) {
  if (!host_value || typeof host_value !== 'string') return false;
  return /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/.test(host_value.trim());
}

function _normalizeIceCandidates(candidates) {
  return (candidates || []).map((candidate) => {
    const address = candidate.address || candidate.ip || '';
    if (!address) return candidate;
    return {
      ...candidate,
      address,
      ip: candidate.ip || address,
    };
  });
}

function _formatIceCandidates(candidates) {
  return _normalizeIceCandidates(candidates)
    .map((c) => `${c.address || c.ip || '?'}:${c.port}/${c.protocol || 'udp'}`)
    .join(', ');
}

function _isBrowserOnLan() {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname.toLowerCase();
  return /^(localhost|127\.0\.0\.1)$/i.test(hostname)
    || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(hostname);
}

export class AgentMedia {
  /**
   * @param {import('../VoiceApiClient.js').VoiceApiClient} apiClient
   * @param {object} [options]
   * @param {boolean} [options.verifyOutboundRtp=true]
   */
  constructor(apiClient, options = {}) {
    this.api = apiClient;
    this.verifyOutboundRtp = options.verifyOutboundRtp !== false;
    this._expectedMediaHost = options.expectedMediaHost || null;
    this._requirePublicIce = options.requirePublicIce === true;

    this._device = null;
    this._sendTransport = null;
    this._recvTransport = null;
    this._producer = null;
    this._consumer = null;
    this._audioTrack = null;
    this._audioElement = null;
    this._sharedAudioContext = null;
    this._producerRegistered = false;
    this._activeCallId = null;
    this._lastAnnouncedIce = '';
    this._onSendTransportUnhealthy = null;
    this._micPrimePromise = null;
    this._micStream = null;
  }

  /**
   * Register callback when send transport drops (failed/disconnected/closed).
   * @param {(payload: { state: string, callId: string|null }) => void|null} handler
   */
  setSendTransportUnhealthyHandler(handler) {
    this._onSendTransportUnhealthy = typeof handler === 'function' ? handler : null;
  }

  isSendPathHealthy() {
    return !!(
      this._sendTransport &&
      this._producer &&
      !this._producer.closed &&
      this._audioTrack &&
      this._audioTrack.readyState === 'live' &&
      this._sendTransport.connectionState === 'connected' &&
      this._producerRegistered
    );
  }

  needsMediaRecovery() {
    if (!this._activeCallId) return false;
    if (!this._sendTransport || !this._producer) return true;
    if (this._producer.closed) return true;
    if (['failed', 'closed', 'disconnected'].includes(this._sendTransport.connectionState)) return true;
    if (this._audioTrack?.readyState !== 'live') return true;
    if (!this._producerRegistered) return true;
    return false;
  }

  async primePlayback() {
    if (typeof window === 'undefined') return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    if (!this._sharedAudioContext) {
      this._sharedAudioContext = new AudioContextCtor();
    }
    if (this._sharedAudioContext.state === 'suspended') {
      await this._sharedAudioContext.resume();
    }
  }

  /**
   * Acquire microphone while a user gesture is still active (call dial / accept click).
   * Must run before long async API calls or the browser will block getUserMedia.
   */
  async primeMicrophone() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      throw new Error('Microphone is only available in a browser environment');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone not supported in this browser');
    }
    if (!window.isSecureContext) {
      throw new Error('HTTPS or localhost is required for microphone access');
    }
    if (this._audioTrack?.readyState === 'live') {
      return { granted: true, muted: this.isMuted() };
    }

    if (this._micPrimePromise) {
      return this._micPrimePromise;
    }

    this._micPrimePromise = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        if (this._micStream && this._micStream !== stream) {
          this._micStream.getTracks().forEach((t) => {
            try { t.stop(); } catch { /* ignore */ }
          });
        }
        this._micStream = stream;

        const track = stream.getAudioTracks()[0];
        if (!track || track.readyState !== 'live') {
          throw new Error('Microphone track unavailable');
        }
        this._audioTrack = track;
        return { granted: true, muted: this.isMuted() };
      } catch (err) {
        const name = err?.name || '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          throw new Error(
            'Microphone permission denied. Click the lock/microphone icon in the browser address bar, allow microphone access, then try again.'
          );
        }
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          throw new Error('No microphone found. Connect a microphone and try again.');
        }
        throw err;
      } finally {
        this._micPrimePromise = null;
      }
    })();

    return this._micPrimePromise;
  }

  hasMicrophone() {
    return !!(this._audioTrack && this._audioTrack.readyState === 'live');
  }

  /**
   * Establish agent send path and optionally remote receive for an active call.
   * @param {string} callId
   * @param {object} [options]
   * @param {boolean} [options.enableRecv=true] - Set false for outbound BIC until callee answers
   * @returns {Promise<{ muted: boolean }>}
   */
  async setupForCall(callId, { enableRecv = true } = {}) {
    if (this._activeCallId && this._activeCallId !== callId) {
      await this.teardown({ terminateRemote: false });
    }

    this._activeCallId = callId;

    if (!this.isSendPathHealthy()) {
      if (this._sendTransport || this._producer || this._device) {
        await this._resetSendPath();
      }
      await this._setupSendPath(callId);
    }

    if (enableRecv) {
      const recv_unhealthy = this._recvTransport
        && ['failed', 'closed', 'disconnected'].includes(this._recvTransport.connectionState);
      if (recv_unhealthy || (this._consumer && this._consumer.closed)) {
        await this._resetRecvPath();
      }
      if (!this._consumer || this._consumer.closed) {
        await this.setupRemoteAudio(callId);
      }
    }

    return { muted: this.isMuted() };
  }

  /**
   * Agent receive path — hear Meta/callee audio. Call after callee answers on outbound BIC.
   * @param {string} callId
   * @returns {Promise<{ muted: boolean }>}
   */
  async setupRemoteAudio(callId) {
    if (this._consumer) {
      return { muted: this.isMuted() };
    }

    if (!this._device || !this._sendTransport) {
      await this.setupForCall(callId, { enableRecv: false });
    }

    this._activeCallId = callId;

    if (!this._recvTransport) {
      const recvData = await this.api.createAgentRecvTransport(callId);
      const recvIceCandidates = _normalizeIceCandidates(recvData.ice_candidates);

      const recvTransportOpts = {
        id: recvData.id,
        iceParameters: recvData.ice_parameters,
        iceCandidates: recvIceCandidates,
        dtlsParameters: recvData.dtls_parameters,
      };
      if (recvData.ice_servers && recvData.ice_servers.length > 0) {
        recvTransportOpts.iceServers = recvData.ice_servers;
      }

      this._recvTransport = this._device.createRecvTransport(recvTransportOpts);

      this._recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          const activeCallId = this._activeCallId || callId;
          await this.api.connectAgentRecvTransport(activeCallId, dtlsParameters);
          callback();
        } catch (err) {
          errback(err);
        }
      });
    }

    const activeCallId = this._activeCallId || callId;
    const consumerInfo = await this.api.consumeAgentAudio(activeCallId, this._device.rtpCapabilities);

    this._consumer = await this._recvTransport.consume({
      id: consumerInfo.id,
      producerId: consumerInfo.producer_id,
      kind: consumerInfo.kind,
      rtpParameters: consumerInfo.rtp_parameters,
    });

    if (this._consumer.paused) {
      await this._consumer.resume();
    }

    await this._waitForTransportConnected(this._recvTransport, 25000);

    const remoteStream = new MediaStream([this._consumer.track]);
    if (!this._audioElement) {
      this._audioElement = document.createElement('audio');
      this._audioElement.setAttribute('playsinline', 'true');
      this._audioElement.autoplay = true;
      this._audioElement.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none';
      document.body.appendChild(this._audioElement);
    }
    this._audioElement.srcObject = remoteStream;

    try {
      await this._audioElement.play();
    } catch (playErr) {
      console.warn('AgentMedia: remote audio autoplay blocked — call primePlayback() on user gesture.', playErr);
    }

    return { muted: this.isMuted() };
  }

  async _waitForTransportConnected(transport, timeoutMs = 25000) {
    if (!transport) {
      throw new Error('WebRTC transport unavailable');
    }
    if (transport.connectionState === 'connected') {
      return;
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        const iceHint = this._lastAnnouncedIce ? ` Server ICE: ${this._lastAnnouncedIce}.` : '';
        reject(new Error(
          `WebRTC transport timeout (state=${transport.connectionState}).` +
          ` Ensure UDP ports 40000-49999 are open on the voice media server.${iceHint}`
        ));
      }, timeoutMs);

      const onStateChange = () => {
        const state = transport.connectionState;
        if (state === 'connected') {
          cleanup();
          resolve();
        } else if (state === 'failed' || state === 'closed') {
          cleanup();
          const iceHint = this._lastAnnouncedIce ? ` Server ICE: ${this._lastAnnouncedIce}.` : '';
          reject(new Error(`WebRTC transport ${state}.${iceHint}`));
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        transport.off('connectionstatechange', onStateChange);
      };

      transport.on('connectionstatechange', onStateChange);
      onStateChange();
    });
  }

  async _resetRecvPath() {
    if (this._consumer) {
      try { this._consumer.close(); } catch { /* ignore */ }
      this._consumer = null;
    }
    if (this._recvTransport) {
      try { this._recvTransport.close(); } catch { /* ignore */ }
      this._recvTransport = null;
    }
    if (this._audioElement) {
      this._audioElement.srcObject = null;
      this._audioElement.remove();
      this._audioElement = null;
    }
  }

  async _resetSendPath({ releaseMic = false } = {}) {
    if (this._producer) {
      try { this._producer.close(); } catch { /* ignore */ }
      this._producer = null;
    }
    if (this._sendTransport) {
      try { this._sendTransport.close(); } catch { /* ignore */ }
      this._sendTransport = null;
    }
    if (releaseMic && this._audioTrack) {
      try { this._audioTrack.stop(); } catch { /* ignore */ }
      this._audioTrack = null;
    }
    if (releaseMic && this._micStream) {
      this._micStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this._micStream = null;
    }
    this._device = null;
    this._producerRegistered = false;
  }

  async _setupSendPath(callId) {
    if (this.isSendPathHealthy()) {
      return;
    }

    if (this._sendTransport || this._producer || this._device) {
      await this._resetSendPath();
    }

    this._producerRegistered = false;

    const { Device } = await import('mediasoup-client');

    if (typeof window !== 'undefined' && !window.isSecureContext) {
      console.warn('AgentMedia: HTTPS or localhost required for reliable microphone access.');
    }

    const transportData = await this.api.createAgentTransport(callId);
    const iceCandidates = _normalizeIceCandidates(transportData.ice_candidates);
    this._lastAnnouncedIce = _formatIceCandidates(iceCandidates);

    const candidate_ips = iceCandidates.map((c) => c.address || c.ip).filter(Boolean);
    if (candidate_ips.length && candidate_ips.every((ip) => ip === '127.0.0.1' || ip === 'localhost')) {
      throw new Error(
        'Voice server returned localhost ICE (127.0.0.1) but mediasoup runs on a remote host. ' +
        'Configure a publicly reachable ICE/media host on the voice service.'
      );
    }

    if (this._expectedMediaHost) {
      const bad = candidate_ips.filter((ip) => ip === '127.0.0.1' || ip === 'localhost');
      if (bad.length) {
        throw new Error(
          `Voice server ICE is localhost but expected media host is ${this._expectedMediaHost}.`
        );
      }
    }

    if (this._requirePublicIce && !_isBrowserOnLan()) {
      const all_private = candidate_ips.length > 0 && candidate_ips.every(
        (ip) => _isPrivateIpv4(ip) || ip === '127.0.0.1' || ip === 'localhost'
      );
      if (all_private) {
        throw new Error(
          `Voice server returned private LAN ICE (${this._lastAnnouncedIce}) but this browser requires a public media host` +
          `${this._expectedMediaHost ? ` (${this._expectedMediaHost})` : ''}. ` +
          'Set gc_public_ip on the voice service and ensure UDP ports 40000-49999 are open.'
        );
      }
    }

    if (typeof console !== 'undefined' && iceCandidates.length) {
      console.info(`AgentMedia: voice server ICE candidates → ${this._lastAnnouncedIce}`);
    }

    this._device = new Device();
    await this._device.load({ routerRtpCapabilities: transportData.rtp_capabilities });

    const sendTransportOpts = {
      id: transportData.id,
      iceParameters: transportData.ice_parameters,
      iceCandidates,
      dtlsParameters: transportData.dtls_parameters,
    };
    if (transportData.ice_servers && transportData.ice_servers.length > 0) {
      sendTransportOpts.iceServers = transportData.ice_servers;
    }

    this._sendTransport = this._device.createSendTransport(sendTransportOpts);

    this._sendTransport.on('connectionstatechange', () => {
      const state = this._sendTransport?.connectionState;
      if (!state || state === 'connected' || state === 'connecting' || state === 'new') return;
      if (this._onSendTransportUnhealthy) {
        this._onSendTransportUnhealthy({
          state,
          callId: this._activeCallId,
        });
      }
    });

    this._sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        const activeCallId = this._activeCallId || callId;
        await this.api.connectAgentTransport(activeCallId, dtlsParameters);
        callback();
      } catch (err) {
        errback(err);
      }
    });

    this._sendTransport.on('produce', async ({ rtpParameters }, callback, errback) => {
      try {
        const activeCallId = this._activeCallId || callId;
        const result = await this.api.produceAgentAudio(activeCallId, rtpParameters);
        if (!result.id) {
          errback(new Error('Server did not return mediasoup producer id'));
          return;
        }
        this._producerRegistered = true;
        callback({ id: result.id });
      } catch (err) {
        errback(err);
      }
    });

    await this.primeMicrophone();

    this._producer = await this._sendTransport.produce({
      track: this._audioTrack,
      codecOptions: { opusDtx: false },
    });

    await this._waitForTransportConnected(this._sendTransport, 25000);

    if (this.verifyOutboundRtp) {
      await this._waitForOutboundRtp(this._producer, { intervalMs: 600, maxTries: 10 });
    }
  }

  async _waitForOutboundRtp(producer, { intervalMs = 600, maxTries = 10 } = {}) {
    if (this._sendTransport?.connectionState !== 'connected') {
      throw new Error(
        `WebRTC send transport not connected (state=${this._sendTransport?.connectionState || 'unknown'})`
      );
    }

    for (let attempt = 1; attempt <= maxTries; attempt += 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
      if (!producer || producer.closed) {
        if (this._sendTransport?.connectionState === 'closed') {
          throw new Error('WebRTC transport closed during RTP verification');
        }
        throw new Error('Producer closed before RTP verification');
      }
      const report = await producer.getStats();
      let packetsSent = 0;
      report.forEach((s) => {
        if (s.type === 'outbound-rtp' && (s.kind === 'audio' || !s.kind)) {
          packetsSent = Math.max(packetsSent, s.packetsSent ?? 0);
        }
      });
      if (packetsSent > 0) return;
    }

    const iceHint = this._lastAnnouncedIce ? ` Server ICE: ${this._lastAnnouncedIce}.` : '';
    throw new Error(
      `Microphone RTP not reaching voice server. Open UDP/TCP ports 40000-49999 on the media host.${iceHint}`
    );
  }

  toggleMute() {
    if (!this._audioTrack) return false;
    this._audioTrack.enabled = !this._audioTrack.enabled;
    return !this._audioTrack.enabled;
  }

  isMuted() {
    return this._audioTrack ? !this._audioTrack.enabled : false;
  }

  isMediaConnected() {
    return this.isSendPathHealthy();
  }

  async teardown({ terminateRemote = false, releaseMic = true } = {}) {
    const callId = this._activeCallId;
    const hadProducer = this._producerRegistered;

    if (this._producer) {
      try { this._producer.close(); } catch { /* ignore */ }
      this._producer = null;
    }
    if (this._consumer) {
      try { this._consumer.close(); } catch { /* ignore */ }
      this._consumer = null;
    }
    if (this._sendTransport) {
      try { this._sendTransport.close(); } catch { /* ignore */ }
      this._sendTransport = null;
    }
    if (this._recvTransport) {
      try { this._recvTransport.close(); } catch { /* ignore */ }
      this._recvTransport = null;
    }
    if (releaseMic && this._audioTrack) {
      try { this._audioTrack.stop(); } catch { /* ignore */ }
      this._audioTrack = null;
    }
    if (releaseMic && this._micStream) {
      this._micStream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      this._micStream = null;
    }
    if (this._audioElement) {
      this._audioElement.srcObject = null;
      this._audioElement.remove();
      this._audioElement = null;
    }
    this._device = null;
    this._producerRegistered = false;
    this._activeCallId = null;
    this._lastAnnouncedIce = '';

    if (terminateRemote && hadProducer && callId) {
      this.api.terminateCall(callId).catch(() => { /* best effort */ });
    }
  }
}
