export const AXI_VERSION = '0.1';

export function success(command, data, { meta = {}, help = [] } = {}) {
  return { axi: AXI_VERSION, ok: true, command, data, meta, help };
}

export function failure(command, error, help = []) {
  return {
    axi: AXI_VERSION,
    ok: false,
    command,
    data: null,
    meta: {},
    help,
    error: {
      code: error.code || 'internal-error',
      message: error.message || 'Unexpected error',
      retryable: Boolean(error.retryable),
      details: error.details || {},
    },
  };
}
