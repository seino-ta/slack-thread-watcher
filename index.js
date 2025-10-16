import "dotenv/config";
import slackBolt from "@slack/bolt";
import axios from "axios";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeReplyText } from "./lib/textRules.js";
import { ensureWindowMs, trimTimestamps } from "./lib/floodUtils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const loadJson = (filename) =>
  JSON.parse(readFileSync(path.join(__dirname, filename), "utf-8"));

// 設定読み込み
const config = loadJson("config.json");
const messages = loadJson("messages.json");

const { App } = slackBolt;

function validateRequiredEnv() {
  const requiredKeys = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
  const missing = requiredKeys.filter(
    (key) => typeof process.env[key] !== "string" || process.env[key].trim().length === 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `環境変数の不足: ${missing.join(", ")}。Slack アプリのトークンを設定してください。`,
    );
  }
}

function validateConfigSchema(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") {
    return ["config.json の構造が不正です"];
  }
  const validModes = new Set(["include", "exclude"]);
  if (!validModes.has(cfg.mode)) {
    errors.push(`mode は ${Array.from(validModes).join(" / ")} のいずれかを指定してください`);
  }
  if (!Array.isArray(cfg.channels) || cfg.channels.some((ch) => typeof ch !== "string")) {
    errors.push("channels は文字列 ID の配列である必要があります");
  }
  const numericValidators = [
    { key: "cooldown_sec_user", min: 0, integer: true },
    { key: "cooldown_sec_channel", min: 0, integer: true },
    { key: "flood_window_sec", min: 1, integer: true },
    { key: "flood_max_posts", min: 1, integer: true },
  ];
  for (const { key, min, integer } of numericValidators) {
    const value = cfg[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`${key} は数値である必要があります`);
    } else if (integer && !Number.isInteger(value)) {
      errors.push(`${key} は整数を指定してください`);
    } else if (value < min) {
      errors.push(`${key} は ${min} 以上を指定してください`);
    }
  }
  if (!cfg.rules || typeof cfg.rules !== "object") {
    errors.push("rules セクションが存在しません");
  } else {
    const ruleKeys = ["no_mention", "non_thread_reply", "flood"];
    for (const key of ruleKeys) {
      if (typeof cfg.rules[key] !== "boolean") {
        errors.push(`rules.${key} は true / false を指定してください`);
      }
    }
  }
  if (cfg.logging !== undefined) {
    if (!cfg.logging || typeof cfg.logging !== "object") {
      errors.push("logging はオブジェクトで指定してください");
    } else {
      if (cfg.logging.level !== undefined && typeof cfg.logging.level !== "string") {
        errors.push("logging.level は文字列で指定してください");
      }
      if (cfg.logging.file !== undefined && typeof cfg.logging.file !== "string") {
        errors.push("logging.file は文字列パスで指定してください");
      }
    }
  }
  return errors;
}

validateRequiredEnv();
const configErrors = validateConfigSchema(config);
if (configErrors.length > 0) {
  throw new Error(`config.json の検証に失敗しました: ${configErrors.join("; ")}`);
}

const LOG_LEVEL_PRIORITY = { error: 0, warn: 1, info: 2, debug: 3 };
const CONSOLE_METHODS = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  debug:
    typeof console.debug === "function"
      ? console.debug.bind(console)
      : console.log.bind(console),
};

function safeSerializeMeta(meta) {
  if (!meta) return "";
  try {
    const keys = Object.keys(meta);
    if (keys.length === 0) return "";
    return JSON.stringify(meta);
  } catch (err) {
    return JSON.stringify({ meta_serialize_error: err.message });
  }
}

function createLogger(activeLevel, filePath) {
  const fallbackRank = LOG_LEVEL_PRIORITY.info;
  const activeRank = LOG_LEVEL_PRIORITY[activeLevel] ?? fallbackRank;

  const shouldLog = (level) =>
    (LOG_LEVEL_PRIORITY[level] ?? LOG_LEVEL_PRIORITY.debug) <= activeRank;

  const write = (level, message, meta) => {
    if (!shouldLog(level)) return;
    const metaText = safeSerializeMeta(meta);
    const consoleText = metaText ? `${message} ${metaText}` : message;
    (CONSOLE_METHODS[level] || console.log)(consoleText);
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${consoleText}`;
    try {
      appendFileSync(filePath, `${line}\n`, "utf-8");
    } catch (err) {
      CONSOLE_METHODS.error(`ログ書き込み失敗: ${err.message}`);
    }
  };

  return {
    level: activeLevel,
    error(message, meta) {
      write("error", message, meta);
    },
    warn(message, meta) {
      write("warn", message, meta);
    },
    info(message, meta) {
      write("info", message, meta);
    },
    debug(message, meta) {
      write("debug", message, meta);
    },
  };
}

const appEnv = (
  process.env.APP_ENV || process.env.NODE_ENV || "production"
).toLowerCase();
const isDevMode = appEnv === "development";
const loggingConfig = config.logging ?? {};
const configuredLevel = (
  process.env.LOG_LEVEL ||
  loggingConfig.level ||
  (isDevMode ? "debug" : "info")
).toLowerCase();
const resolvedLevel = Object.prototype.hasOwnProperty.call(
  LOG_LEVEL_PRIORITY,
  configuredLevel
)
  ? configuredLevel
  : isDevMode
  ? "debug"
  : "info";
const logFileSetting =
  process.env.LOG_FILE ||
  loggingConfig.file ||
  (isDevMode ? "logs/dev.log" : "logs/app.log");
const logFilePath = path.isAbsolute(logFileSetting)
  ? logFileSetting
  : path.join(__dirname, logFileSetting);
const logDir = path.dirname(logFilePath);
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}
const logger = createLogger(resolvedLevel, logFilePath);
logger.info("ロガー初期化", {
  env: appEnv,
  level: resolvedLevel,
  file: logFilePath,
});

// Bolt初期化（Socket Mode）
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// -------------
// ユーティリティ
// -------------
const includeMode = config.mode === "include";
const channelSet = new Set(config.channels);
const inMemoryWarnUserTs = new Map(); // key: userId -> lastWarnedEpochMs
const inMemoryWarnChannelTs = new Map(); // key: channelId -> lastWarnedEpochMs
const inMemoryPostHistory = new Map(); // key: `${user}_${channel}` -> [epochMs]
const now = () => Date.now();
const cooldownStateFile = path.join(__dirname, "cooldown_state.csv");
let persistScheduled = false;

function loadCooldownState() {
  if (!existsSync(cooldownStateFile)) {
    logger.debug("クールダウン状態ファイルが存在しないため新規開始", {
      file: cooldownStateFile,
    });
    return;
  }
  try {
    const lines = readFileSync(cooldownStateFile, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0 && !line.startsWith("#"));
    for (const line of lines) {
      const [kind, id, ts] = line.split(",");
      const timestamp = Number(ts);
      if (!id || Number.isNaN(timestamp)) continue;
      if (kind === "user") {
        inMemoryWarnUserTs.set(id, timestamp);
      } else if (kind === "channel") {
        inMemoryWarnChannelTs.set(id, timestamp);
      }
    }
  } catch (err) {
    logger.warn("クールダウン状態の読み込みに失敗", {
      file: cooldownStateFile,
      error: err.message,
    });
    return;
  }
  logger.debug("クールダウン状態を読み込み", {
    file: cooldownStateFile,
    userEntries: inMemoryWarnUserTs.size,
    channelEntries: inMemoryWarnChannelTs.size,
  });
}

function persistCooldownState() {
  const lines = [];
  for (const [id, ts] of inMemoryWarnUserTs.entries()) {
    lines.push(`user,${id},${ts}`);
  }
  for (const [id, ts] of inMemoryWarnChannelTs.entries()) {
    lines.push(`channel,${id},${ts}`);
  }
  const payload = lines.length ? `${lines.join("\n")}\n` : "";
  writeFileSync(cooldownStateFile, payload, "utf-8");
  logger.debug("クールダウン状態を保存", {
    file: cooldownStateFile,
    userEntries: inMemoryWarnUserTs.size,
    channelEntries: inMemoryWarnChannelTs.size,
  });
}

function schedulePersistCooldownState() {
  if (persistScheduled) return;
  persistScheduled = true;
  setTimeout(() => {
    persistScheduled = false;
    try {
      persistCooldownState();
    } catch (err) {
      logger.warn("クールダウン状態の保存に失敗", {
        file: cooldownStateFile,
        error: err.message,
      });
    }
  }, 50);
}

loadCooldownState();

function isMonitoredChannel(channelId) {
  if (!channelId) return false;
  return includeMode ? channelSet.has(channelId) : !channelSet.has(channelId);
}

function containsUserMention(text = "") {
  // <@U123...> または <@W...>
  return /<@([UW][A-Z0-9]+)>/.test(text);
}

function canWarnUser(userId, cooldownSec) {
  const last = inMemoryWarnUserTs.get(userId) || 0;
  const current = now();
  if (current - last < cooldownSec * 1000) return false;
  inMemoryWarnUserTs.set(userId, current);
  schedulePersistCooldownState();
  return true;
}

function canWarnChannel(channelId, cooldownSec) {
  const last = inMemoryWarnChannelTs.get(channelId) || 0;
  const current = now();
  if (current - last < cooldownSec * 1000) return false;
  inMemoryWarnChannelTs.set(channelId, current);
  schedulePersistCooldownState();
  return true;
}

function pushPostHistory(userId, channelId, windowSec) {
  const key = `${userId}_${channelId}`;
  const list = inMemoryPostHistory.get(key) || [];
  const t = now();
  list.push(t);
  const windowMs = ensureWindowMs(windowSec);
  const filtered = trimTimestamps(list, windowMs, t);
  inMemoryPostHistory.set(key, filtered);
  return filtered;
}

async function appendLog(rule, event, extra = {}) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) {
    logger.debug("SHEETS_WEBHOOK_URL 未設定のためログ送信をスキップ", {
      rule,
    });
    return;
  }
  try {
    await axios.post(
      url,
      {
        timestamp: new Date().toISOString(),
        rule,
        user: event.user,
        channel: event.channel,
        ts: event.ts,
        text: (event.text || "").slice(0, 500),
        ...extra,
      },
      { timeout: 5000 },
    );
    logger.debug("スプレッドシート用ログを送信", {
      rule,
      user: event.user,
      channel: event.channel,
    });
  } catch (e) {
    logger.warn("スプレッドシート用ログ送信に失敗", {
      rule,
      error: e.message,
    });
  }
}

let shuttingDown = false;

async function shutdown(exitCode, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("シャットダウン処理を開始", { reason, exitCode });
  try {
    persistCooldownState();
    logger.debug("シャットダウン時にクールダウン状態を保存", {
      file: cooldownStateFile,
    });
  } catch (err) {
    logger.warn("シャットダウン時のクールダウン保存に失敗", {
      error: err.message,
    });
  }

  try {
    await app.stop();
    logger.info("Bolt アプリの停止が完了", { reason });
  } catch (err) {
    logger.warn("Bolt アプリの停止に失敗", {
      error: err.message,
    });
  } finally {
    process.exit(exitCode);
  }
}

function registerProcessHandlers() {
  const signals = ["SIGINT", "SIGTERM", "SIGQUIT"];
  for (const signal of signals) {
    process.once(signal, () => {
      shutdown(0, signal).catch((err) => {
        logger.error("シャットダウン処理中に例外", {
          error: err.message,
          stack: err.stack,
        });
        process.exit(1);
      });
    });
  }

  process.once("uncaughtException", (err) => {
    logger.error("未捕捉例外が発生", {
      error: err.message,
      stack: err.stack,
    });
    shutdown(1, "uncaughtException");
  });

  process.once("unhandledRejection", (reason) => {
    const message =
      reason instanceof Error ? reason.message : JSON.stringify(reason);
    logger.error("未処理の Promise 拒否が発生", {
      reason: message,
    });
    shutdown(1, "unhandledRejection");
  });
}

// -------------
// メインハンドラ
// -------------
app.event("message", async ({ event, client, logger: boltLogger }) => {
  try {
    const text = event.text || "";
    const snippet =
      text.length > 120 ? `${text.slice(0, 117)}...` : text;
    const baseMeta = {
      user: event.user,
      channel: event.channel,
      ts: event.ts,
      snippet,
    };

    logger.debug("メッセージイベントを受信", baseMeta);

    if (event.subtype || event.bot_id) {
      logger.debug("Botまたはサブタイプ投稿のためスキップ", {
        ...baseMeta,
        subtype: event.subtype,
        botId: event.bot_id,
      });
      return;
    }

    if (event.thread_ts) {
      logger.debug("スレッド投稿のためスキップ", {
        ...baseMeta,
        thread: event.thread_ts,
      });
      return;
    }

    if (!isMonitoredChannel(event.channel)) {
      logger.debug("監視対象外チャンネルのためスキップ", baseMeta);
      return;
    }

    // 1) @なし
    if (config.rules.no_mention && !containsUserMention(text)) {
      const okUser = canWarnUser(event.user, config.cooldown_sec_user);
      const okCh = canWarnChannel(event.channel, config.cooldown_sec_channel);
      if (okUser && okCh) {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: event.user,
          text: messages.no_mention,
        });
        logger.info("no_mention ルールで注意を送信", baseMeta);
        await appendLog("no_mention", event);
        return; // 一度注意したら他ルールはスキップでもOK
      }
      logger.debug("no_mention ルールはクールダウン中のためスキップ", {
        ...baseMeta,
        cooldownUser: !okUser,
        cooldownChannel: !okCh,
      });
    }

    // 2) 非スレッド返信っぽい
    if (config.rules.non_thread_reply && looksLikeReplyText(text)) {
      const okUser = canWarnUser(event.user, config.cooldown_sec_user);
      const okCh = canWarnChannel(event.channel, config.cooldown_sec_channel);
      if (okUser && okCh) {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: event.user,
          text: messages.non_thread_reply,
        });
        logger.info("non_thread_reply ルールで注意を送信", baseMeta);
        await appendLog("non_thread_reply", event);
      } else {
        logger.debug("non_thread_reply ルールはクールダウン中のためスキップ", {
          ...baseMeta,
          cooldownUser: !okUser,
          cooldownChannel: !okCh,
        });
      }
    }

    // 3) 連投（Flood）
    if (config.rules.flood) {
      const windowMs = ensureWindowMs(config.flood_window_sec);
      const posts = pushPostHistory(event.user, event.channel, config.flood_window_sec);
      const threshold = config.flood_max_posts;
      logger.debug("flood ルール用の投稿数を計測", {
        ...baseMeta,
        recentCount: posts.length,
        windowMs,
      });
      if (posts.length >= threshold) {
        const okUser = canWarnUser(event.user, config.cooldown_sec_user);
        const okCh = canWarnChannel(event.channel, config.cooldown_sec_channel);
        if (okUser && okCh) {
          await client.chat.postEphemeral({
            channel: event.channel,
            user: event.user,
            text: messages.flood,
          });
          logger.info("flood ルールで注意を送信", {
            ...baseMeta,
            recentCount: posts.length,
            windowMs,
          });
          await appendLog("flood", event, { count: posts.length });
        } else {
          logger.debug("flood ルールはクールダウン中のためスキップ", {
            ...baseMeta,
            recentCount: posts.length,
            windowMs,
            cooldownUser: !okUser,
            cooldownChannel: !okCh,
          });
        }
      }
    }
  } catch (err) {
    logger.error("メッセージイベント処理で例外", {
      error: err.message,
      stack: err.stack,
      user: event?.user,
      channel: event?.channel,
    });
    boltLogger?.error(err);
  }
});

// -------------
// 起動
// -------------
const runtimeEnv = (
  process.env.NODE_ENV || process.env.APP_ENV || "production"
).toLowerCase();
const shouldAutoStart = runtimeEnv !== "test";

if (shouldAutoStart) {
  registerProcessHandlers();
  (async () => {
    const port = process.env.PORT || 3000;
    await app.start(port);
    logger.info("⚡️ Slack Patrol Bot が起動しました", {
      mode: config.mode,
      env: appEnv,
      port,
      devMode: isDevMode,
      logLevel: logger.level,
      logFile: logFilePath,
    });
  })().catch((err) => {
    logger.error("Slack アプリの起動に失敗", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });
} else {
  logger.info("テストモードのため Slack アプリの自動起動をスキップ", {
    env: runtimeEnv,
  });
}
