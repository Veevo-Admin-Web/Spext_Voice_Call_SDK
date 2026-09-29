/**
 * Structured error thrown by SDK HTTP clients.
 */
export class VoiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'VoiceError';
    this.error_code = options.error_code || '';
    this.error_filter = options.error_filter || '';
    this.error_description = options.error_description || message;
    this.http_status = options.http_status || null;
    this.rate_limit = options.rate_limit || null;
    this.response = options.response || null;
  }

  static fromApiResponse(data, http_status) {
    return new VoiceError(data.ERROR_DESCRIPTION || 'Request failed', {
      error_code: data.ERROR_CODE,
      error_filter: data.ERROR_FILTER,
      error_description: data.ERROR_DESCRIPTION,
      http_status,
      rate_limit: data.RATE_LIMIT || null,
      response: data,
    });
  }
}
