// One line per event: "<ISO time> <level> [<context>] <message>". The context is usually the account's email.
export function createLogger(context, out = console) {
  const line = (level, msg) => `${new Date().toISOString()} ${level.padEnd(5)} ${context ? `[${context}] ` : ''}${msg}`;
  return {
    info: (msg) => out.log(line('info', msg)),
    warn: (msg) => out.warn(line('warn', msg)),
    error: (msg) => out.error(line('error', msg)),
  };
}

// WebSocket close codes the cloud sends without a reason text (RFC 6455 §7.4.1).
const CLOSE_CODES = {
  1000: 'normal closure',
  1001: 'server going away',
  1006: 'connection lost',
  1008: 'policy violation (token rejected?)',
  1011: 'server error',
  1012: 'server restarting',
  1013: 'try again later',
};

export const describeClose = (code, reason) => reason || CLOSE_CODES[code] || 'no reason given';
