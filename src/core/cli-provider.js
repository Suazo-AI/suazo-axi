import { AxiError } from './errors.js';
import { runProcess } from './process.js';

function safeProviderCode(output) {
  try {
    const value = JSON.parse(output);
    const code = value?.error?.code ?? value?.code;
    return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export async function runJsonCli({
  provider,
  file,
  prefixArgs = [],
  args,
  timeoutMs = 15_000,
  maxBytes = 1_000_000,
  runner = runProcess,
}) {
  const result = await runner(file, [...prefixArgs, ...args], { timeoutMs, maxBytes });
  if (result.code !== 0) {
    const providerCode = safeProviderCode(result.stdout);
    throw new AxiError(`${provider}-error`, `${provider} command failed`, {
      retryable: true,
      details: { provider, exitCode: result.code, ...(providerCode ? { providerCode } : {}) },
    });
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new AxiError('provider-invalid-response', `${provider} returned invalid JSON`, {
      retryable: true,
      details: { provider },
    });
  }
}
