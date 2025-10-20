import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMockClient } from "../helpers/mockClient.js";
import { createMockLogger } from "../helpers/mockLogger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..", "..");
const DEFAULT_CHANNEL = "C123";

function loadConfig() {
  return JSON.parse(
    readFileSync(path.join(projectRoot, "config.json"), "utf-8"),
  );
}

function loadMessages() {
  return JSON.parse(
    readFileSync(path.join(projectRoot, "messages.json"), "utf-8"),
  );
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function createContext({ configOverrides = {}, cooldownState } = {}) {
  const config = loadConfig();
  deepMerge(config, {
    channels: [DEFAULT_CHANNEL],
    mode: "include",
  });
  deepMerge(config, configOverrides);
  const messages = loadMessages();
  const { logger } = createMockLogger();
  const { client, calls } = createMockClient();
  const handler = createMessageHandler({ config, messages, logger, cooldownState, client });
  return { handler, config, messages, calls };
}

function createMessageHandler({ config, messages, logger, cooldownState, client }) {
  const includeMode = config.mode === "include";
  const channelSet = new Set(config.channels);
  const warnUserTs = new Map();
  const warnChannelTs = new Map();
  const postHistory = new Map();

  if (cooldownState?.user) {
    for (const [id, ts] of Object.entries(cooldownState.user)) {
      warnUserTs.set(id, ts);
    }
  }
  if (cooldownState?.channel) {
    for (const [id, ts] of Object.entries(cooldownState.channel)) {
      warnChannelTs.set(id, ts);
    }
  }

  const now = () => Date.now();

  const containsUserMention = (text = "") => /<@([UW][A-Z0-9]+)>/.test(text);

  const canWarnUser = (userId, cooldownSec) => {
    const last = warnUserTs.get(userId) || 0;
    const current = now();
    if (current - last < cooldownSec * 1000) return false;
    warnUserTs.set(userId, current);
    return true;
  };

  const canWarnChannel = (channelId, cooldownSec) => {
    const last = warnChannelTs.get(channelId) || 0;
    const current = now();
    if (current - last < cooldownSec * 1000) return false;
    warnChannelTs.set(channelId, current);
    return true;
  };

  const pushPostHistory = (userId, channelId, windowSec) => {
    const key = `${userId}_${channelId}`;
    const list = postHistory.get(key) || [];
    const t = now();
    list.push(t);
    const windowMs = windowSec * 1000;
    const filtered = list.filter((x) => t - x <= windowMs);
    postHistory.set(key, filtered);
    return filtered;
  };

  const isMonitoredChannel = (channelId) => {
    if (!channelId) return false;
    return includeMode ? channelSet.has(channelId) : !channelSet.has(channelId);
  };

  const looksLikeReplyText = (text = "") => /\bre:/i.test(text.trim());

  return {
    async handle(event) {
      const text = event.text || "";

      if (event.subtype || event.bot_id) return;
      if (event.thread_ts) return;
      if (!isMonitoredChannel(event.channel)) return;

      if (config.rules.no_mention && !containsUserMention(text)) {
        const okUser = canWarnUser(event.user, config.cooldown_sec_user);
        const okCh = canWarnChannel(event.channel, config.cooldown_sec_channel);
        if (okUser && okCh) {
          await client.chat.postEphemeral({
            channel: event.channel,
            user: event.user,
            text: messages.no_mention,
          });
          return;
        }
        return;
      }

      if (config.rules.non_thread_reply && looksLikeReplyText(text)) {
        const okUser = canWarnUser(event.user, config.cooldown_sec_user);
        const okCh = canWarnChannel(event.channel, config.cooldown_sec_channel);
        if (okUser && okCh) {
          await client.chat.postEphemeral({
            channel: event.channel,
            user: event.user,
            text: messages.non_thread_reply,
          });
          return;
        }
      }

      if (config.rules.flood) {
        const posts = pushPostHistory(event.user, event.channel, config.flood_window_sec);
        if (posts.length >= config.flood_max_posts) {
          const okUser = canWarnUser(event.user, config.cooldown_sec_user);
          const okCh = canWarnChannel(event.channel, config.cooldown_sec_channel);
          if (okUser && okCh) {
            await client.chat.postEphemeral({
              channel: event.channel,
              user: event.user,
              text: messages.flood,
            });
          }
        }
      }
    },
  };
}

const baseEvent = {
  channel: DEFAULT_CHANNEL,
  user: "U123",
  ts: "123.456",
  text: "こんにちは",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-05-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("message handler rules toggle", () => {
  test("no_mention ルールが有効な場合に警告する", async () => {
    const { handler, calls, messages } = createContext();
    await handler.handle({ ...baseEvent, text: "メンションなし" });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.text).toBe(messages.no_mention);
  });

  test("no_mention ルールが無効なら警告しない", async () => {
    const { handler, calls } = createContext({
      configOverrides: { rules: { no_mention: false } },
    });
    await handler.handle({ ...baseEvent, text: "メンションなし" });
    expect(calls).toHaveLength(0);
  });

  test("non_thread_reply ルールが有効な場合に警告する", async () => {
    const { handler, calls, messages } = createContext({
      configOverrides: { rules: { no_mention: false, non_thread_reply: true } },
    });
    await handler.handle({ ...baseEvent, text: "<@U999> re: 了解" });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.text).toBe(messages.non_thread_reply);
  });

  test("non_thread_reply ルールが無効なら警告しない", async () => {
    const { handler, calls } = createContext({
      configOverrides: { rules: { non_thread_reply: false } },
    });
    await handler.handle({ ...baseEvent, text: "<@U999> re: 了解" });
    expect(calls).toHaveLength(0);
  });

  test("flood ルールが閾値を超えたら警告する", async () => {
    const { handler, calls, messages } = createContext({
      configOverrides: {
        rules: { no_mention: false, non_thread_reply: false, flood: true },
        flood_max_posts: 3,
        flood_window_sec: 60,
      },
    });
    const event = { ...baseEvent, text: "<@U999> 投稿", user: "U777" };
    await handler.handle(event);
    await handler.handle(event);
    await handler.handle(event);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.text).toBe(messages.flood);
  });

  test("flood ルールが無効なら警告しない", async () => {
    const { handler, calls } = createContext({
      configOverrides: {
        rules: { no_mention: false, non_thread_reply: false, flood: false },
        flood_max_posts: 3,
        flood_window_sec: 60,
      },
    });
    const event = { ...baseEvent, text: "<@U999> 投稿", user: "U888" };
    await handler.handle(event);
    await handler.handle(event);
    await handler.handle(event);
    expect(calls).toHaveLength(0);
  });
});
