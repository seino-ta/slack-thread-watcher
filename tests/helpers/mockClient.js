export function createMockClient() {
  const calls = [];
  return {
    calls,
    client: {
      chat: {
        postEphemeral: async (payload) => {
          calls.push({ method: "chat.postEphemeral", payload });
          return { ok: true };
        },
      },
    },
  };
}
