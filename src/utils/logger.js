function safeData(data) {
  if (!data || typeof data !== 'object') return {};
  const clone = {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Error) {
      clone[k] = {
        name: v.name,
        message: v.message,
        stack: v.stack,
      };
      continue;
    }
    clone[k] = v;
  }
  return clone;
}

export function createLogger(scope = 'app') {
  function log(level, event, data = {}) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      scope,
      event,
      ...safeData(data),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    debug: (event, data) => log('debug', event, data),
    info: (event, data) => log('info', event, data),
    warn: (event, data) => log('warn', event, data),
    error: (event, data) => log('error', event, data),
  };
}

