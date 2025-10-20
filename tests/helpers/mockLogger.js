export function createMockLogger() {
  const entries = [];
  const record = (level) => (message, meta) => {
    entries.push({ level, message, meta });
  };
  return {
    entries,
    logger: {
      level: "test",
      error: record("error"),
      warn: record("warn"),
      info: record("info"),
      debug: record("debug"),
    },
  };
}
