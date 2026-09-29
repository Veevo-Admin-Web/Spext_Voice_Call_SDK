/**
 * Shared constants for the WA Voice SDK.
 */

export const API_STATUS = {
  SUCCESSFUL: 'SUCCESSFUL',
  ERROR: 'ERROR',
};

export const CALL_DIRECTION = {
  BUSINESS_INITIATED: 'BUSINESS_INITIATED',
  USER_INITIATED: 'USER_INITIATED',
};

export const CALL_STATUS = {
  INITIATING: 'INITIATING',
  INITIATED: 'INITIATED',
  RINGING: 'RINGING',
  CONNECTING: 'CONNECTING',
  ACTIVE: 'ACTIVE',
  TERMINATED: 'TERMINATED',
};

export const PERMISSION_STATUS = {
  NOT_REQUESTED: 'NOT_REQUESTED',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DECLINED: 'DECLINED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
};

export const WS_EVENTS = {
  AUTH_OK: 'AUTH_OK',
  INCOMING_CALL: 'incoming_call',
  CALL_DIALING: 'call_dialing',
  CALL_RINGING: 'call_ringing',
  CALL_ACCEPTED: 'call_accepted',
  CALL_CONNECTED: 'call_connected',
  CALL_REJECTED: 'call_rejected',
  CALL_TERMINATED: 'call_terminated',
  CALL_MEDIA_WARNING: 'call_media_warning',
  PERMISSION_APPROVED: 'call_permission_approved',
  PERMISSION_DECLINED: 'call_permission_declined',
};

export const DEFAULT_WS_PATH = '/ws/agents';
export const DEFAULT_STATUS_POLL_MS = 500;
export const FAST_STATUS_POLL_MS = 400;
export const DEFAULT_WS_RECONNECT_MAX_MS = 30000;
export const DEFAULT_WS_HEARTBEAT_MS = 25000;
export const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 90000;
