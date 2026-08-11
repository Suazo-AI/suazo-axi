import { AxiError } from './errors.js';
import { runProcess } from './process.js';

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
    throw new AxiError(`${provider}-error`, `${provider} command failed`, {
      retryable: true,
      details: { provider, exitCode: result.code },
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
