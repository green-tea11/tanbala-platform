#!/usr/bin/env node
// Симулятор диалога WhatsApp-бота Tanbala: настоящая сборка бота (main из dist) с поддельным подключением WhatsApp,
// временной базой и сценарием клиента. Запуск: node run.mjs <сценарий.json>. Настройки в README.md.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createActivity, createSimClock, realSleep, waitIdle } from './lib/activity.mjs';
import { buildEnv, createSimRoot, isInside, loadBot } from './lib/bot.mjs';
import { createFakeLeads } from './lib/fake-leads.mjs';
import { createFakeSdk, createHints, createSchemaStore, wrapLlm } from './lib/llm.mjs';
import {
  createVoiceStore,
  installFetch,
  installListenGuard,
  installNetGuard,
  requestOrigin,
} from './lib/network.mjs';
import {
  almaty,
  createMask,
  renderLog,
  renderPrompts,
  renderTranscript,
  summaryOf,
  totalsOf,
} from './lib/report.mjs';
import { openState } from './lib/state.mjs';
import { createFakeWhatsApp } from './lib/whatsapp.mjs';

const PHONE = /^77\d{9}$/u;
/** Номер «самого бота» в поддельном сокете: не совпадает ни с клиентом, ни с менеджером. */
const BOT_PHONE = '77000000098';
/** Номер менеджера по умолчанию: поддельный, уведомления уходят в поддельный WhatsApp и видны в транскрипте. */
const DEFAULT_MANAGER = '77000000009';
const RESEARCH_POLL_MS = 10_000;
const STOP_TIMEOUT_MS = 60_000;

function say(text) {
  process.stdout.write(`${text}\n`);
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name}: нужно число не меньше 0`);
  return value;
}

function isMessageTurn(turn) {
  return typeof turn.text === 'string' || turn.voice === true || turn.other !== undefined;
}

function loadScenario(path) {
  const scenario = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(scenario.turns) || scenario.turns.length === 0) {
    throw new Error('В сценарии нет turns');
  }
  scenario.turns.forEach((turn, index) => {
    const known =
      isMessageTurn(turn) ||
      typeof turn.waitForResearchMs === 'number' ||
      typeof turn.pauseMs === 'number' ||
      typeof turn.comment === 'string';
    if (!known) throw new Error(`Ход ${index + 1}: нужен text, voice, other, waitForResearchMs, pauseMs или comment`);
  });
  return scenario;
}

function silentLogger() {
  const noop = () => undefined;
  const logger = { level: 'silent', trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, silent: noop };
  logger.child = () => logger;
  return logger;
}

function readTokenLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function readOptions(scenario, scenarioPath) {
  const managerRaw = process.env.SIM_MANAGER_PHONE ?? DEFAULT_MANAGER;
  const options = {
    scenarioName: basename(scenarioPath).replace(/\.json$/u, ''),
    botRoot: resolve(process.env.BOT_ROOT ?? '/opt/tanbala/whatsapp'),
    fake: process.env.SIM_FAKE === '1',
    blockNet: process.env.SIM_BLOCK_NET === '1',
    phone: process.env.SIM_PHONE ?? scenario.phone,
    managerPhone: managerRaw === 'none' ? null : managerRaw,
    timeScale: numberEnv('SIM_TIME_SCALE', 1),
    typingSkip: process.env.SIM_TYPING === 'skip',
    settleMs: numberEnv('SIM_SETTLE_MS', 2000),
    turnTimeoutMs: numberEnv('SIM_TURN_TIMEOUT_MS', 300_000),
    keepDb: process.env.SIM_KEEP_DB === '1',
    fakeResearchMs: numberEnv('SIM_FAKE_RESEARCH_MS', 8000),
  };
  if (!PHONE.test(options.phone ?? '')) throw new Error('Номер клиента (phone или SIM_PHONE) нужен в формате 77XXXXXXXXX');
  if (options.managerPhone !== null && !/^\d{11,15}$/u.test(options.managerPhone)) {
    throw new Error('SIM_MANAGER_PHONE: только цифры, 11-15, или none');
  }
  if (options.phone === options.managerPhone || options.phone === BOT_PHONE) {
    throw new Error('Номер клиента совпал с номером менеджера или бота симулятора');
  }
  return options;
}

async function run() {
  const scenarioPath = process.argv[2];
  if (scenarioPath === undefined) {
    say('Использование: node run.mjs <сценарий.json>  (настройки в README.md)');
    return 2;
  }
  const scenario = loadScenario(resolve(scenarioPath));
  const options = readOptions(scenario, scenarioPath);
  const stamp = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 19).replace(/[-:]/gu, '').replace('T', '-');
  const outDir = resolve(process.env.SIM_OUT ?? join(tmpdir(), 'tanbala-sim-out', `${options.scenarioName}-${stamp}`));
  mkdirSync(outDir, { recursive: true });

  const bot = await loadBot(options.botRoot);
  const simRoot = createSimRoot(options.botRoot);
  const { env, secrets } = buildEnv({
    bot,
    botRoot: options.botRoot,
    processEnv: process.env,
    phone: options.phone,
    managerPhone: options.managerPhone,
    fake: options.fake,
  });
  const mask = createMask([...secrets, env.INTERNAL_API_TOKEN ?? '']);
  const { config } = bot.loadConfig(env, bot.readModelsJson(simRoot), simRoot);
  // Предохранители: все пути данных во временном корне, ключ Claude есть.
  for (const [name, path] of Object.entries({
    DATABASE_PATH: config.databasePath,
    WHATSAPP_SESSION_DIR: config.waSessionDir,
    TOKEN_LOG_PATH: config.tokenLogPath,
  })) {
    if (!isInside(simRoot, path) || isInside(options.botRoot, path)) throw new Error(`${name} вне временного корня: стоп`);
  }
  if (config.anthropicKey === null) throw new Error('В .env нет VENMART_ANTHROPIC_KEY: бот не будет отвечать');

  const events = {
    list: [],
    turn: 0,
    push(event) {
      const full = { at: Date.now(), turn: this.turn, ...event };
      this.list.push(full);
      return full;
    },
  };
  const activity = createActivity();
  const network = { blockedFetch: 0, blockedSockets: 0, blockedListen: 0, leads: 0, openrouter: 0, other: 0 };
  const typing = {
    on: false,
    skip: options.typingSkip,
    set(value) {
      this.on = value;
    },
    isOn() {
      return this.on;
    },
  };
  const clock = createSimClock({
    activity,
    timeScale: options.timeScale,
    typing,
    onSkippedTyping: (ms) => events.push({ type: 'skippedTyping', ms }),
  });
  const voiceStore = createVoiceStore();
  const hints = createHints();
  const schemas = createSchemaStore(bot.toJsonSchema);
  const leadsBaseUrl = config.companyApi?.baseUrl ?? null;
  installFetch({
    fake: options.fake,
    leadsBaseUrl,
    fakeLeads: createFakeLeads({
      extraCompanies: scenario.fake?.companies ?? [],
      researchFinds: scenario.fake?.researchFinds ?? [],
      researchMs: options.fakeResearchMs * options.timeScale,
    }),
    voiceStore,
    events,
    activity,
    stats: network,
  });
  // SIM_BLOCK_NET=1: настоящий режим без сети (проверка сборки: каждый вызов Claude и почты падает, бот передаёт чат).
  if (options.fake || options.blockNet) installNetGuard(network);
  installListenGuard(network);

  const fakeSdk = createFakeSdk({ hints, latencyMs: 40 });
  const createLlm = (deps) =>
    wrapLlm(
      options.fake ? bot.createAnthropicLlm({ ...deps, createSdk: () => fakeSdk }) : bot.createAnthropicLlm(deps),
      { events, activity, schemas },
    );
  let state = null;
  const wa = createFakeWhatsApp({
    dist: bot,
    scenario,
    phone: options.phone,
    botPhone: BOT_PHONE,
    managerPhone: config.managerPhone,
    events,
    typing,
    voiceStore,
    outboundInfo: (waId) => state?.outbound(waId) ?? null,
  });
  const logDestination = {
    write(line) {
      activity.touch();
      try {
        const { level, time: _time, pid: _pid, hostname: _host, msg, ...ctx } = JSON.parse(line);
        events.push({ type: 'log', level, msg, ctx });
      } catch {
        events.push({ type: 'note', text: `строка лога не JSON: ${String(line).slice(0, 200)}` });
      }
    },
  };
  process.on('unhandledRejection', (error) => {
    events.push({ type: 'note', text: `необработанный отказ промиса: ${error?.name ?? error}` });
  });

  say(`Симулятор: ${options.scenarioName}, режим ${options.fake ? 'подделки' : options.blockNet ? 'настоящий без сети (SIM_BLOCK_NET=1)' : 'настоящий Claude и почта'}, бот ${options.botRoot}`);
  say(`Вывод: ${outDir}`);
  const startedAt = Date.now();
  const turnResults = new Map([[0, { turn: { comment: 'запуск' } }]]);
  let app = null;
  let timedOut = 0;

  const writeOutputs = (failure) => {
    const tokenLines = readTokenLog(join(simRoot, 'data', 'token-usage.jsonl'));
    const meta = {
      scenarioName: options.scenarioName,
      fake: options.fake,
      botRoot: options.botRoot,
      startedAt,
      durationMs: Date.now() - startedAt,
      phone: options.phone,
      models: config.models,
      companyApi: config.companyApi !== null,
      voice: config.voice !== null,
      manager:
        config.managerPhone === null
          ? 'не задан'
          : options.managerPhone === DEFAULT_MANAGER
            ? 'поддельный номер симулятора'
            : 'из SIM_MANAGER_PHONE',
      timeScale: options.timeScale,
      typingSkip: options.typingSkip,
      totals: totalsOf(events.list, tokenLines),
      network,
      blockNet: options.blockNet,
      failure: failure ?? null,
      timedOutTurns: timedOut,
      outDir,
    };
    const files = {
      'transcript.md': renderTranscript({ meta, scenario, events: events.list, turnResults }),
      'log.md': renderLog({ meta, events: events.list, turnResults }),
      'prompts.md': renderPrompts({ meta, events: events.list, schemas: schemas.all() }),
      'summary.json': JSON.stringify(summaryOf({ meta, events: events.list, turnResults }), null, 2),
      'tokens.jsonl': tokenLines.map((line) => JSON.stringify(line)).join('\n'),
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(outDir, name), mask(text), 'utf8');
    return meta;
  };

  const waitResearch = async (maxMs, directory) => {
    const startedWait = Date.now();
    const chatId = state.chatId(options.phone);
    let last = 'неизвестно';
    while (Date.now() - startedWait < maxMs) {
      const research = chatId === null ? null : (state.companyState(chatId)?.research ?? null);
      const waited = () => Date.now() - startedWait;
      if (research === null) return { ok: true, waitedMs: waited(), status: 'проверки новой компании нет' };
      if (research.status !== 'queued' && research.status !== 'running') {
        return { ok: true, waitedMs: waited(), status: `в базе бота уже ${research.status}` };
      }
      if (directory !== null) {
        const remote = await requestOrigin.run({ origin: 'sim' }, () => directory.researchStatus(research.jobId));
        last = remote.ok ? remote.value.status : `сбой ${remote.failure}`;
        if (remote.ok && remote.value.status !== 'queued' && remote.value.status !== 'running') {
          return { ok: true, waitedMs: waited(), status: `в почте ${last}, бот узнает при следующем сообщении` };
        }
      }
      await realSleep(Math.max(500, Math.min(RESEARCH_POLL_MS * options.timeScale, maxMs - waited())));
    }
    return { ok: false, waitedMs: Date.now() - startedWait, status: `не закончилась за отведённое время (${last})` };
  };

  const printTurn = (index) => {
    for (const event of events.list.filter((item) => item.turn === index)) {
      if (event.type === 'out') say(`  ${almaty(event.at)} бот → ${event.to === 'client' ? 'клиенту' : 'менеджеру'}: ${event.text.replaceAll('\n', ' / ')}`);
      if (event.type === 'log' && typeof event.ctx.outcome === 'string') say(`  ${almaty(event.at)} ${event.msg}`);
    }
  };

  try {
    app = await bot.main({
      env,
      root: simRoot,
      startWhatsApp: wa.start,
      logDestination,
      clock,
      createLlm,
      startPanel: async () => undefined,
      startConsoleApi: async () => undefined,
    });
    state = openState(bot.Database, config.databasePath);
    await wa.offlineQueueDone();
    await waitIdle(activity, { settleMs: Math.min(options.settleMs, 500), timeoutMs: 30_000 });
    events.push({ type: 'state', snapshot: state.snapshot(options.phone, 0) });
    const directory =
      config.companyApi === null
        ? null
        : bot.createCompanyDirectory({
            baseUrl: config.companyApi.baseUrl,
            token: config.companyApi.token,
            clock: { now: () => Date.now() },
            logger: silentLogger(),
          });
    let lastDraftId = 0;
    for (const [position, turn] of scenario.turns.entries()) {
      const index = position + 1;
      events.turn = index;
      const result = { turn, wait: null };
      turnResults.set(index, result);
      if (isMessageTurn(turn)) {
        if (typeof turn.waitMs === 'number' && turn.waitMs > 0) await realSleep(turn.waitMs * options.timeScale);
        hints.set(turn.fake);
        const preview = turn.text ?? (turn.voice ? `[голосовое${turn.transcript ? `: ${turn.transcript}` : ''}]` : `[${turn.other}]`);
        say(`ход ${index}: клиент: ${preview}`);
        await wa.send(turn);
        if (turn.noWait === true) continue;
        result.wait = await waitIdle(activity, {
          settleMs: options.settleMs,
          timeoutMs: turn.timeoutMs ?? options.turnTimeoutMs,
        });
      } else if (typeof turn.waitForResearchMs === 'number') {
        say(`ход ${index}: ждём проверку новой компании до ${turn.waitForResearchMs} мс`);
        result.wait = await waitResearch(turn.waitForResearchMs * options.timeScale, directory);
        say(`  ${result.wait.status}`);
      } else if (typeof turn.pauseMs === 'number') {
        await realSleep(turn.pauseMs * options.timeScale);
        continue;
      } else {
        continue;
      }
      if (!result.wait.ok) timedOut += 1;
      printTurn(index);
      const snapshot = state.snapshot(options.phone, lastDraftId);
      lastDraftId = snapshot.lastDraftId;
      events.push({ type: 'state', snapshot });
    }
    events.turn = scenario.turns.length;
    await waitIdle(activity, { settleMs: options.settleMs, timeoutMs: options.turnTimeoutMs });
  } catch (error) {
    events.push({ type: 'note', text: `Сбой симулятора: ${error?.name ?? 'Error'}: ${mask(error?.message ?? String(error))}` });
    say(`Сбой: ${error?.name ?? 'Error'}: ${mask(error?.message ?? String(error))}`);
    state?.close();
    state = null;
    if (app !== null) await Promise.race([app.stop(), realSleep(STOP_TIMEOUT_MS)]);
    writeOutputs(`${error?.name ?? 'Error'}: ${mask(error?.message ?? String(error))}`);
    if (!options.keepDb) rmSync(simRoot, { recursive: true, force: true });
    return 1;
  }
  state.close();
  state = null;
  await Promise.race([app.stop(), realSleep(STOP_TIMEOUT_MS)]);
  const meta = writeOutputs(null);
  if (options.keepDb) say(`Временная база оставлена: ${join(simRoot, 'data', 'sim.db')}`);
  else rmSync(simRoot, { recursive: true, force: true });
  say(
    `Готово за ${(meta.durationMs / 1000).toFixed(1)} с: вызовов Claude ${meta.totals.llmCalls}, ` +
      `сообщений клиенту ${meta.totals.toClient}, менеджеру ${meta.totals.toManager}` +
      (options.fake || options.blockNet ? `, заблокировано наружу ${network.blockedFetch + network.blockedSockets}` : ''),
  );
  say(`Файлы: ${join(outDir, 'transcript.md')}, log.md, prompts.md, summary.json, tokens.jsonl`);
  return timedOut > 0 ? 3 : 0;
}

run().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`Симулятор не запустился: ${error?.name ?? 'Error'}: ${error?.message ?? error}\n`);
    process.exit(1);
  },
);
