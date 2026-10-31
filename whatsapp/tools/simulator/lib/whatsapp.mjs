// Поддельное подключение WhatsApp для шва MainOptions.startWhatsApp. Baileys не запускается, папка сессии не
// читается. Входящие идут тем же путём, что у настоящего адаптера: сырое сообщение Baileys (WAMessage) =>
// whatsapp/message-intake.js (номер собеседника, whatsapp/inbound.classifyUpsert с TEST_ALLOWLIST, границей привязки,
// менеджером) => deps.onEvent (main: запись в базу, очередь склейки, конвейер ответа).
import { randomBytes } from 'node:crypto';

function hex(bytes) {
  return randomBytes(bytes).toString('hex').toUpperCase();
}

/** Профиль собеседника для определения компании: personal по умолчанию, business с сайтами из сценария. */
function profileResultOf(profile) {
  if (profile?.kind === 'business') {
    return {
      kind: 'business',
      websites: Array.isArray(profile.websites) ? profile.websites : [],
      email: typeof profile.email === 'string' ? profile.email : null,
    };
  }
  if (profile?.kind === 'failed') return { kind: 'failed' };
  return { kind: 'personal' };
}

function contentOf(turn) {
  if (typeof turn.text === 'string') return { conversation: turn.text };
  if (turn.voice === true) {
    return {
      audioMessage: {
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
        seconds: Number.isInteger(turn.seconds) ? turn.seconds : 9,
      },
    };
  }
  if (turn.other === 'image') return { imageMessage: { mimetype: 'image/jpeg', caption: '' } };
  return { stickerMessage: { mimetype: 'image/webp' } };
}

export function createFakeWhatsApp({
  dist,
  scenario,
  phone,
  botPhone,
  managerPhone,
  events,
  typing,
  voiceStore,
  outboundInfo,
}) {
  const managerJid = managerPhone === null ? null : `${managerPhone}@s.whatsapp.net`;
  const clientJid = `${phone}@s.whatsapp.net`;
  let deps = null;
  let intake = null;
  let resolver = null;
  let outCounter = 0;
  let inCounter = 0;
  const profile = profileResultOf(scenario.profile);

  const fakeSocket = {
    user: { id: `${botPhone}:7@s.whatsapp.net` },
    signalRepository: {
      lidMapping: { getPNForLID: async () => null, getLIDForPN: async () => null },
    },
  };

  const connection = {
    newMessageId() {
      outCounter += 1;
      return `SIMOUT${String(outCounter).padStart(4, '0')}${hex(4)}`;
    },
    async sendText(jid, text, messageId) {
      const info = outboundInfo(messageId);
      events.push({
        type: 'out',
        to: jid === clientJid ? 'client' : jid === managerJid ? 'manager' : 'other',
        text,
        waId: messageId,
        origin: info?.origin ?? null,
      });
    },
    async setTyping(_jid, on) {
      typing.set(on);
      events.push({ type: 'typing', on });
    },
    async markRead(_jid, waIds) {
      events.push({ type: 'read', count: waIds.length });
    },
    async downloadAudio(media) {
      events.push({ type: 'note', text: 'Бот скачал голосовое (поддельное аудио)' });
      return voiceStore.clip(String(media));
    },
    resolvePhone: async () => null,
    async businessProfile() {
      events.push({ type: 'note', text: `Бот запросил бизнес-профиль: ${profile.kind}` });
      return profile;
    },
    async profilePhoto() {
      return null;
    },
    async stop() {
      events.push({ type: 'note', text: 'Поддельный WhatsApp остановлен' });
    },
  };

  /** Шов startWhatsApp: как первая привязка (граница старых сообщений) и open, без сокета и без сессии. */
  async function start(whatsAppDeps) {
    deps = whatsAppDeps;
    if (deps.appState.getLinkedAtMs() === null) {
      deps.appState.setLinkedAtMs(deps.clock.now() - dist.LINKED_AT_SKEW_MS);
    }
    resolver = dist.createLidResolver(fakeSocket, deps.logger);
    const intakeDeps = {
      ...deps,
      onEvent: (event) => {
        events.push({
          type: 'classified',
          event: event.type,
          reason: event.type === 'ignore' ? event.reason : null,
        });
        return deps.onEvent(event);
      },
    };
    intake = dist.createMessageIntake({
      deps: intakeDeps,
      classify: dist.classifyUpsert,
      onTooManyFailures: async () => {
        events.push({ type: 'note', text: 'Приём сообщений остановлен: три сбоя подряд (handler_failed)' });
      },
    });
    deps.onConnectionUpdate?.('open');
    return connection;
  }

  /** Сообщение клиента одного хода через приём сообщений адаптера (событие messages.upsert, тип notify). */
  async function send(turn) {
    if (deps === null) throw new Error('Поддельный WhatsApp не запущен: main не вызвал startWhatsApp');
    inCounter += 1;
    const waId = `SIMIN${String(inCounter).padStart(4, '0')}${hex(6)}`;
    if (turn.voice === true) voiceStore.add(waId, turn.transcript);
    const message = {
      key: { remoteJid: clientJid, fromMe: false, id: waId },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: scenario.pushName ?? null,
      ...(typeof scenario.verifiedName === 'string' ? { verifiedBizName: scenario.verifiedName } : {}),
      message: contentOf(turn),
    };
    const kind = typeof turn.text === 'string' ? 'text' : turn.voice === true ? 'voice' : 'other';
    events.push({
      type: 'client',
      waId,
      kind,
      text: turn.text ?? null,
      transcript: turn.voice === true ? (turn.transcript ?? null) : null,
      seconds: turn.voice === true ? (message.message.audioMessage?.seconds ?? null) : null,
      other: kind === 'other' ? (turn.other ?? 'sticker') : null,
    });
    await intake.messages({ messages: [message], type: 'notify' }, resolver, deps.appState.getLinkedAtMs());
    return waId;
  }

  return {
    start,
    send,
    clientJid,
    offlineQueueDone: () => deps?.onOfflineQueueDone() ?? Promise.resolve(),
  };
}
