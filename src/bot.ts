import { Bot, Context } from "grammy";
import { transcribe } from "./transcribe.ts";
import {
  abortSession,
  answerQuestion,
  createSession,
  sendPromptAsync,
  startEventStream,
} from "./opencode.ts";
import type { OpenCodeEvent } from "./opencode.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN environment variable is required");
  process.exit(1);
}

console.log("Creating bot instance...");
const bot = new Bot(token);

const sessionByChat = new Map<number, string>();
const chatBySession = new Map<string, number>();
const sessionStorePath = path.join(process.cwd(), "sessions.json");
let sessionSaveTimer: NodeJS.Timeout | undefined;
const activeMessageBySession = new Map<string, string>();
const debugEvents = !!process.env.OPENCODE_DEBUG_EVENTS;
const sessionTurnBySession = new Map<string, number>();
const lastUserTextBySession = new Map<string, string>();
const messageTurnByMessageId = new Map<string, number>();
let lastChatId: number | undefined;
const questionByPollId = new Map<
  string,
  { sessionId: string; questionId: string; options: string[]; callID?: string; messageID?: string }
>();
const pollIdByQuestionId = new Map<string, string>();

type MessageState = {
  messageId: string;
  sessionId: string;
  chatId: number;
  role?: string;
  text: string;
  telegramMessageId?: number;
  updatedAt: number;
  flushTimer?: NodeJS.Timeout;
  done?: boolean;
};

const messageStates = new Map<string, MessageState>();

function loadSessionsFromDisk(): void {
  if (!fs.existsSync(sessionStorePath)) return;
  try {
    const raw = fs.readFileSync(sessionStorePath, "utf-8");
    const data = JSON.parse(raw) as { chatId: number; sessionId: string }[];
    sessionByChat.clear();
    chatBySession.clear();
    for (const entry of data) {
      if (!entry || typeof entry.chatId !== "number" || typeof entry.sessionId !== "string") {
        continue;
      }
      sessionByChat.set(entry.chatId, entry.sessionId);
      chatBySession.set(entry.sessionId, entry.chatId);
    }
    console.log(`Loaded ${sessionByChat.size} sessions from disk`);
  } catch (err) {
    console.error("Failed to load sessions from disk:", err);
  }
}

function scheduleSessionSave(): void {
  if (sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = undefined;
    const data = Array.from(sessionByChat.entries()).map(([chatId, sessionId]) => ({
      chatId,
      sessionId,
    }));
    try {
      fs.writeFileSync(sessionStorePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("Failed to save sessions to disk:", err);
    }
  }, 500);
}

bot.catch((err) => {
  console.error("Unhandled bot error:", err);
});

bot.command("start", async (ctx) => {
  console.log(`/start command from user ${ctx.from?.id} (@${ctx.from?.username})`);
  const chatId = ctx.chat?.id;
  if (chatId) {
    try {
      await getSessionForChat(chatId);
    } catch (err) {
      console.error("Failed to initialize session on /start:", err);
      return ctx.reply("Failed to initialize session. Check server logs.");
    }
  }
  return ctx.reply("Send me a voice message or audio file and I'll transcribe it.");
});

async function resetSessionForChat(chatId: number): Promise<string> {
  const session = await createSession(`telegram:${chatId}`);
  sessionByChat.set(chatId, session.id);
  chatBySession.set(session.id, chatId);
  scheduleSessionSave();
  activeMessageBySession.delete(session.id);
  sessionTurnBySession.delete(session.id);
  lastUserTextBySession.delete(session.id);
  try {
    await sendPromptAsync(session.id, [{ type: "text", text: "hello" }], { noReply: true });
  } catch (err) {
    console.error("Failed to initialize OpenCode session:", err);
  }
  return session.id;
}

// /reset resets the OpenCode session for this chat.
bot.command("reset", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  try {
    await resetSessionForChat(chatId);
    await ctx.reply("Started a new session.");
  } catch (err) {
    console.error("Failed to reset session:", err);
    await ctx.reply("Failed to reset session. Check server logs.");
  }
});

// /stop interrupts the current OpenCode session for this chat.
bot.command("stop", async (ctx) => {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const sessionId = sessionByChat.get(chatId);
  if (!sessionId) {
    await ctx.reply("No active session to stop.");
    return;
  }
  try {
    await abortSession(sessionId);
    await ctx.reply("Stopped the current session.");
  } catch (err) {
    console.error("Failed to stop session:", err);
    await ctx.reply("Failed to stop session. Check server logs.");
  }
});

async function getSessionForChat(chatId: number): Promise<string> {
  const existing = sessionByChat.get(chatId);
  if (existing) return existing;

  const session = await createSession(`telegram:${chatId}`);
  sessionByChat.set(chatId, session.id);
  chatBySession.set(session.id, chatId);
  scheduleSessionSave();
  try {
    await sendPromptAsync(session.id, [{ type: "text", text: "hello" }], { noReply: true });
  } catch (err) {
    console.error("Failed to initialize OpenCode session:", err);
  }
  return session.id;
}

function extractMessageId(obj: any): string | undefined {
  if (!obj || typeof obj !== "object") return;
  return obj.messageID || obj.messageId || obj.id || obj.info?.messageID || obj.info?.id;
}

function extractSessionId(obj: any): string | undefined {
  if (!obj || typeof obj !== "object") return;
  return (
    obj.sessionID ||
    obj.sessionId ||
    obj.session?.id ||
    obj.info?.sessionID ||
    obj.info?.sessionId ||
    obj.sessionID ||
    obj.sessionId
  );
}

function extractTextFromMessage(message: any): string {
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string") return message.text;
  const parts = message.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
  }
  return "";
}

function normalizeMessagePayload(payload: any): any {
  if (!payload || typeof payload !== "object") return payload;
  if (payload.message) return payload.message;
  if (payload.info && payload.parts) {
    return { ...payload.info, parts: payload.parts };
  }
  return payload;
}

function getMessageMeta(payload: any): { messageId?: string; sessionId?: string } {
  const candidates = [
    payload,
    payload?.info,
    payload?.message,
    payload?.message?.info,
    payload?.part,
    payload?.part?.info,
  ];

  for (const candidate of candidates) {
    const messageId = extractMessageId(candidate);
    const sessionId = extractSessionId(candidate);
    if (messageId || sessionId) {
      return { messageId, sessionId };
    }
  }
  return {};
}

async function flushMessage(state: MessageState): Promise<void> {
  const content = state.text.trim();
  if (!content) {
    if (state.done) {
      messageStates.delete(state.messageId);
    }
    return;
  }
  const lastUserText = lastUserTextBySession.get(state.sessionId);
  if (lastUserText && content === lastUserText) {
    if (state.done) {
      messageStates.delete(state.messageId);
    }
    return;
  }
  try {
    if (!state.telegramMessageId) {
      const sent = await bot.api.sendMessage(state.chatId, content);
      state.telegramMessageId = sent.message_id;
    } else {
      await bot.api.editMessageText(state.chatId, state.telegramMessageId, content);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("message is not modified")) {
      return;
    }
    console.error("Failed to send OpenCode update to Telegram:", err);
  } finally {
    if (state.done) {
      messageStates.delete(state.messageId);
    }
  }
}

function scheduleFlush(state: MessageState, force = false): void {
  if (state.flushTimer && !force) return;
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(() => {
    state.flushTimer = undefined;
    void flushMessage(state);
  }, force ? 0 : 800);
}

function upsertMessageState(messageId: string, sessionId: string): MessageState | null {
  const chatId = chatBySession.get(sessionId);
  if (!chatId) return null;

  const existing = messageStates.get(messageId);
  if (existing) return existing;

  const state: MessageState = {
    messageId,
    sessionId,
    chatId,
    text: "",
    updatedAt: Date.now(),
  };
  messageStates.set(messageId, state);
  return state;
}

function getTurnForSession(sessionId: string): number {
  return sessionTurnBySession.get(sessionId) ?? 0;
}

function getMessageKey(messageId: string, sessionId: string): string {
  const existingTurn = messageTurnByMessageId.get(messageId);
  const turn = existingTurn ?? getTurnForSession(sessionId);
  if (existingTurn === undefined) {
    messageTurnByMessageId.set(messageId, turn);
  }
  return `${messageId}:${turn}`;
}

function noteUserPrompt(sessionId: string, text: string): void {
  const nextTurn = (sessionTurnBySession.get(sessionId) ?? 0) + 1;
  sessionTurnBySession.set(sessionId, nextTurn);
  lastUserTextBySession.set(sessionId, text.trim());
  activeMessageBySession.delete(sessionId);
}

const unknownEvents = new Set<string>();

function normalizeEvent(evt: OpenCodeEvent): { name: string; payload: any } {
  let name = evt.event;
  let payload: any = evt.data;

  if (name === "message" && payload && typeof payload === "object") {
    if (typeof payload.type === "string") {
      name = payload.type;
      payload = payload.payload ?? payload.data ?? payload.body ?? payload.message ?? payload;
    } else if (typeof payload.event === "string") {
      name = payload.event;
      payload = payload.data ?? payload.payload ?? payload.message ?? payload;
    }
  }

  if (payload && typeof payload === "object") {
    if (typeof payload.type === "string" && payload.properties !== undefined) {
      if (name === "message") {
        name = payload.type;
      }
      payload = payload.properties ?? payload;
    }
    const nextPayload =
      payload.payload ??
      payload.data ??
      payload.body ??
      payload.message ??
      payload.session ??
      payload.info ??
      payload;
    payload = nextPayload;
  }

  return { name, payload };
}

function logEventIfDebug(eventName: string, payload: any): void {
  if (!debugEvents) return;
  try {
    const serialized = JSON.stringify(payload, null, 2);
    console.log(`[OpenCode debug] ${eventName}: ${serialized}`);
  } catch (err) {
    console.log(`[OpenCode debug] ${eventName}:`, payload);
  }
}

function extractSessionText(payload: any): string {
  const candidates = [
    payload?.message?.parts,
    payload?.parts,
    payload?.message?.text,
    payload?.text,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const text = candidate
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      if (text) return text;
      continue;
    }
    if (typeof candidate === "string" && candidate) return candidate;
  }

  return "";
}

function extractTextFromDiff(diff: any): string {
  if (!Array.isArray(diff)) return "";
  const chunks: string[] = [];
  for (const entry of diff) {
    if (!entry || typeof entry !== "object") continue;
    const direct =
      entry?.message?.text ??
      entry?.text ??
      entry?.part?.text ??
      entry?.part?.delta ??
      entry?.delta ??
      "";
    if (typeof direct === "string" && direct) {
      chunks.push(direct);
      continue;
    }
    const parts = entry?.message?.parts ?? entry?.parts;
    if (Array.isArray(parts)) {
      const text = parts
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      if (text) chunks.push(text);
    }
  }
  return chunks.join("");
}

function extractQuestionPayload(payload: any): {
  questionId?: string;
  sessionId?: string;
  title?: string;
  text?: string;
  options: string[];
  allowsMultiple?: boolean;
  callID?: string;
  messageID?: string;
} {
  const question = Array.isArray(payload?.questions) ? payload.questions[0] : undefined;
  const questionId =
    question?.id ??
    payload?.questionID ??
    payload?.questionId ??
    payload?.id ??
    payload?.info?.questionID ??
    payload?.info?.questionId ??
    payload?.info?.id;

  const sessionId =
    extractSessionId(payload) ||
    extractSessionId(payload?.session) ||
    extractSessionId(payload?.info) ||
    payload?.sessionID ||
    payload?.sessionId;

  const title =
    question?.header ??
    payload?.title ??
    payload?.header ??
    payload?.info?.title ??
    payload?.info?.header;
  const text =
    question?.question ??
    question?.prompt ??
    question?.text ??
    payload?.question ??
    payload?.prompt ??
    payload?.text ??
    payload?.info?.question ??
    payload?.info?.prompt ??
    payload?.info?.text;

  const rawOptions =
    question?.options ??
    payload?.options ??
    payload?.choices ??
    payload?.answers ??
    payload?.info?.options;
  const options: string[] = Array.isArray(rawOptions)
    ? rawOptions
        .map((option: any) => {
          if (typeof option === "string") return option;
          if (!option || typeof option !== "object") return "";
          return (
            option.label ??
            option.title ??
            option.text ??
            option.value ??
            option.id ??
            ""
          );
        })
        .filter((value) => typeof value === "string" && value.trim())
        .map((value) => value.trim())
    : [];

  const allowsMultiple = !!(
    question?.multiple ??
    payload?.allowsMultiple ??
    payload?.multi ??
    payload?.multiple
  );

  const callID = payload?.tool?.callID ?? payload?.tool?.callId;
  const messageID = payload?.tool?.messageID ?? payload?.tool?.messageId;

  return { questionId, sessionId, title, text, options, allowsMultiple, callID, messageID };
}

function clampPollText(value: string, max: number): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function sendQuestionPoll(payload: any): Promise<void> {
  const { questionId, sessionId, title, text, options, allowsMultiple, callID, messageID } =
    extractQuestionPayload(payload);
  if (!sessionId || !questionId) {
    console.error("Question event missing sessionId or questionId.");
    return;
  }
  const chatId = chatBySession.get(sessionId);
  if (!chatId) {
    console.error(`No chat found for session ${sessionId} (question ${questionId}).`);
    return;
  }

  const prompt = clampPollText(
    [title, text].filter((value) => value && value.trim()).join("\n"),
    300
  );

  let pollOptions =
    options.length > 0 ? options.slice(0, 10) : [];
  if (pollOptions.length < 2) {
    pollOptions = pollOptions.length === 1
      ? [pollOptions[0], "Cancel"]
      : ["Yes", "No"];
  }

  const normalizedOptions = pollOptions.map((value) => clampPollText(value, 100));

  const sent = await bot.api.sendPoll(chatId, prompt || "Question", normalizedOptions, {
    is_anonymous: false,
    allows_multiple_answers: allowsMultiple,
  });

  if (sent.poll?.id) {
    questionByPollId.set(sent.poll.id, {
      sessionId,
      questionId,
      options: normalizedOptions,
      callID,
      messageID,
    });
    pollIdByQuestionId.set(questionId, sent.poll.id);
  }
}

function handleOpenCodeEvent(evt: OpenCodeEvent): void {
  const { name: eventName, payload } = normalizeEvent(evt);

  if (
    eventName.startsWith("session.") ||
    eventName === "server.heartbeat" ||
    eventName.startsWith("question.")
  ) {
    logEventIfDebug(eventName, payload);
  }

  if (eventName === "server.heartbeat" || eventName === "server.connected") {
    return;
  }

  if (eventName === "question.asked") {
    void sendQuestionPoll(payload).catch((err) => {
      console.error("Failed to send question poll:", err);
    });
    return;
  }
  if (eventName === "question.rejected") {
    const questionId =
      payload?.questionID ??
      payload?.questionId ??
      payload?.id ??
      payload?.info?.questionID ??
      payload?.info?.questionId ??
      payload?.info?.id;
    if (questionId) {
      const pollId = pollIdByQuestionId.get(questionId);
      if (pollId) {
        questionByPollId.delete(pollId);
        pollIdByQuestionId.delete(questionId);
      }
    }
    return;
  }

  if (eventName === "message.updated") {
    const message = normalizeMessagePayload(payload);
    const messageId = extractMessageId(message);
    const sessionId = extractSessionId(message);
    if (!messageId || !sessionId) return;

    const role = message.role;
    if (role && role !== "assistant") return;

    const messageKey = getMessageKey(messageId, sessionId);
    const state = upsertMessageState(messageKey, sessionId);
    if (!state) return;

    state.role = role ?? state.role;
    const nextText = extractTextFromMessage(message);
    if (nextText) state.text = nextText;
    state.updatedAt = Date.now();

    const status = message.status || message.state;
    if (status === "done" || status === "completed" || status === "success") {
      state.done = true;
      scheduleFlush(state, true);
      return;
    }

    scheduleFlush(state);
    activeMessageBySession.set(sessionId, messageId);
    return;
  }

  if (
    eventName === "session.updated" ||
    eventName === "session.status" ||
    eventName === "session.diff" ||
    eventName === "session.idle"
  ) {
    const sessionId =
      extractSessionId(payload) ||
      extractSessionId(payload?.session) ||
      extractSessionId(payload?.info) ||
      payload?.info?.id ||
      payload?.sessionID ||
      payload?.sessionId;
    if (!sessionId) return;

    let messageId = extractMessageId(payload);
    if (!messageId) {
      const existing = activeMessageBySession.get(sessionId);
      if (existing) {
        messageId = existing;
      } else {
        messageId = `${sessionId}:${Date.now()}`;
        activeMessageBySession.set(sessionId, messageId);
      }
    }

    const messageKey = getMessageKey(messageId, sessionId);
    const state = upsertMessageState(messageKey, sessionId);
    if (!state) return;

    const role = payload?.role ?? payload?.message?.role;
    if (role && role !== "assistant") return;

    const diffText = eventName === "session.diff" ? extractTextFromDiff(payload?.diff) : "";
    const nextText = extractSessionText(payload);
    const hasText = !!diffText || !!nextText;
    if (eventName === "session.diff" && diffText) {
      state.text += diffText;
    } else if (nextText) {
      if (nextText.length >= state.text.length && nextText.startsWith(state.text)) {
        state.text = nextText;
      } else {
        state.text = nextText;
      }
    }

    if (hasText) {
      state.updatedAt = Date.now();
    }

    const status =
      payload?.status ??
      payload?.state ??
      payload?.session?.status ??
      payload?.session?.state ??
      payload?.status?.type ??
      payload?.session?.status?.type;
    if (
      status === "done" ||
      status === "completed" ||
      status === "success" ||
      status === "idle" ||
      eventName === "session.idle"
    ) {
      state.done = true;
      if (hasText) {
        scheduleFlush(state, true);
      } else {
        messageStates.delete(state.messageId);
      }
      return;
    }

    if (hasText) {
      scheduleFlush(state);
      activeMessageBySession.set(sessionId, messageId);
    }
    return;
  }

  if (
    eventName === "message.part.updated" ||
    eventName === "message.part_updated" ||
    eventName === "message.part.delta" ||
    eventName === "message.delta"
  ) {
    const meta = getMessageMeta(payload);
    let { messageId, sessionId } = meta;
    if (!sessionId) return;
    if (!messageId) {
      const existing = activeMessageBySession.get(sessionId);
      if (existing) {
        messageId = existing;
      } else {
        console.log("OpenCode delta event missing messageId; creating synthetic id");
        messageId = `${sessionId}:${Date.now()}`;
        activeMessageBySession.set(sessionId, messageId);
      }
    }

    const role = payload?.role ?? payload?.message?.role ?? payload?.part?.role;
    if (role && role !== "assistant") return;

    const messageKey = getMessageKey(messageId, sessionId);
    const state = upsertMessageState(messageKey, sessionId);
    if (!state) return;

    const part = payload?.part ?? payload;
    const partType = part?.type ?? payload?.type;
    if (partType && partType !== "text") return;

    const delta = part?.delta ?? payload?.delta;
    if (typeof delta === "string") {
      state.text += delta;
    } else {
      const text = part?.text ?? payload?.text;
      if (typeof text === "string") {
        if (text.length >= state.text.length && text.startsWith(state.text)) {
          state.text = text;
        } else {
          state.text = text;
        }
      }
    }

    state.updatedAt = Date.now();
    scheduleFlush(state);
    return;
  }

  if (!unknownEvents.has(eventName)) {
    unknownEvents.add(eventName);
    console.log(`Unhandled OpenCode event: ${eventName}`);
  }
}

async function handleAudio(ctx: Context, fileId: string) {
  const user = ctx.from;
  console.log(`Audio received from user ${user?.id} (@${user?.username}), fileId: ${fileId}`);

  const startedAt = Date.now();

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-bot-"));
  const audioPath = path.join(tmpDir, "audio.ogg");

  try {
    console.log("Fetching file info from Telegram...");
    const file = await ctx.api.getFile(fileId);
    console.log(`File info: path=${file.file_path}, size=${file.file_size}`);

    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    console.log("Downloading audio file...");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(audioPath, buffer);
    console.log(`Audio saved to ${audioPath} (${buffer.length} bytes)`);

    console.log("Starting transcription...");
    const text = await transcribe(audioPath);
    const durationMs = Date.now() - startedAt;
    if (text.trim()) {
      console.log(`Transcription succeeded in ${durationMs}ms, length=${text.length}`);
      console.log(`Transcription preview: "${text.slice(0, 200)}"`);
    } else {
      console.log(`Transcription completed in ${durationMs}ms, but result was empty`);
    }

    if (!text.trim()) {
      await ctx.reply("(No speech detected)");
      console.log("No speech detected; sent fallback message to user");
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const sessionId = await getSessionForChat(chatId);
    try {
      await sendPromptAsync(sessionId, [{ type: "text", text }]);
      noteUserPrompt(sessionId, text);
      console.log("Forwarded transcription to OpenCode");
    } catch (err) {
      console.error("Failed to forward transcription to OpenCode:", err);
      await ctx.reply("Failed to send message to OpenCode. Check server logs.");
    }
  } catch (err) {
    console.error("Transcription error:", err);
    await ctx.reply("Failed to transcribe audio. Check server logs.");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`Cleaned up temp dir ${tmpDir}`);
  }
}

bot.on("message:voice", (ctx) => {
  console.log("Voice message received");
  lastChatId = ctx.chat?.id;
  return handleAudio(ctx, ctx.message.voice.file_id);
});

bot.on("message:audio", (ctx) => {
  console.log("Audio file received");
  lastChatId = ctx.chat?.id;
  return handleAudio(ctx, ctx.message.audio.file_id);
});

bot.on("message:video_note", (ctx) => {
  console.log("Video note received");
  lastChatId = ctx.chat?.id;
  return handleAudio(ctx, ctx.message.video_note.file_id);
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  console.log(`Text message from user ${ctx.from?.id}: "${text.slice(0, 80)}"`);
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  lastChatId = chatId;

  try {
    const sessionId = await getSessionForChat(chatId);
    await sendPromptAsync(sessionId, [{ type: "text", text }]);
    noteUserPrompt(sessionId, text);
    console.log("Forwarded text to OpenCode");
  } catch (err) {
    console.error("Failed to forward text to OpenCode:", err);
    await ctx.reply("Failed to send message to OpenCode. Check server logs.");
  }
});

bot.on("poll_answer", async (ctx) => {
  const pollAnswer = ctx.update.poll_answer;
  const pollId = pollAnswer?.poll_id;
  console.log(
    `Poll answer received: pollId=${pollId ?? "unknown"} user=${pollAnswer?.user?.id ?? "unknown"}`
  );
  if (!pollId) return;
  const question = questionByPollId.get(pollId);
  if (!question) return;
  console.log(
    `Poll answer matched question ${question.questionId} for session ${question.sessionId}`
  );

  const selections = pollAnswer.option_ids ?? [];
  const chosenLabels = selections
    .map((idx) => question.options[idx])
    .filter((value): value is string => typeof value === "string");

  const answer =
    chosenLabels.length === 1 ? chosenLabels[0] : chosenLabels;

  try {
    console.log(
      `Sending poll answer to OpenCode: questionId=${question.questionId} selections=${selections.join(",")}`
    );
    await answerQuestion(question.sessionId, question.questionId, answer, selections, {
      callID: question.callID,
      messageID: question.messageID,
    });
    questionByPollId.delete(pollId);
    console.log(`OpenCode question answered: questionId=${question.questionId}`);
  } catch (err) {
    console.error("Failed to answer OpenCode question:", err);
    const fallbackText =
      typeof answer === "string" ? answer : answer.join(", ");
    try {
      await sendPromptAsync(question.sessionId, [{ type: "text", text: fallbackText }]);
      console.log("Sent fallback answer as text to OpenCode.");
    } catch (fallbackErr) {
      console.error("Failed to send fallback answer as text:", fallbackErr);
    }
  }
});

const consoleReader = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

consoleReader.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!trimmed.startsWith("/reset") && !trimmed.startsWith("/stop")) {
    console.log(`Console command not recognized: ${trimmed}`);
    return;
  }
  const parts = trimmed.split(/\s+/);
  const command = parts[0];
  const target = parts[1];
  const chatId = target ? Number(target) : lastChatId;
  if (!chatId || Number.isNaN(chatId)) {
    console.log("Usage: /reset <chatId> or /stop <chatId> (or send a message first to set lastChatId)");
    return;
  }
  try {
    if (command === "/stop") {
      const sessionId = sessionByChat.get(chatId);
      if (!sessionId) {
        console.log(`No active session for chat ${chatId}`);
        return;
      }
      await abortSession(sessionId);
      console.log(`Stopped session for chat ${chatId}`);
    } else {
      await resetSessionForChat(chatId);
      console.log(`Reset session for chat ${chatId}`);
    }
  } catch (err) {
    console.error(`Failed to handle ${command} for chat ${chatId}:`, err);
  }
});

console.log("Connecting to Telegram...");
try {
  const me = await bot.api.getMe();
  console.log(`Authenticated as @${me.username} (id: ${me.id})`);
} catch (err) {
  console.error("Failed to connect to Telegram:", err);
  process.exit(1);
}

loadSessionsFromDisk();

console.log("Connecting to OpenCode event stream...");
startEventStream(handleOpenCodeEvent).catch((err) => {
  console.error("Failed to start OpenCode event stream:", err);
});

bot.start({
  onStart: (info) => console.log(`Bot @${info.username} is polling for updates`),
});
