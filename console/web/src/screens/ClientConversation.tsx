import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiPost } from '../lib/api';
import { clockTime } from '../lib/format';
import { composeNote, NOTE_MAX, noteLength } from '../lib/note';
import type { BotStatus, ChatCard, Message } from '../lib/types';

const REPLY_MAX = 4096;

function dayLabel(isoText: string, now: number): string {
  const label = clockTime(isoText, now);
  if (/^\d\d:\d\d$/.test(label)) return 'Сегодня';
  if (label.startsWith('вчера')) return 'Вчера';
  return label.split(' ')[0] ?? '';
}

function messageText(message: Message): { text: string; placeholder: boolean } {
  if (message.kind === 'voice') {
    return message.text ? { text: message.text, placeholder: false } : { text: 'Голосовое, расшифровки нет', placeholder: true };
  }
  if (message.kind === 'other') return { text: 'Сообщение другого вида: фото, файл или стикер', placeholder: true };
  return { text: message.text ?? '', placeholder: message.text === null };
}

export function Messages({ card, now }: { readonly card: ChatCard; readonly now: number }) {
  const listRef = useRef<HTMLOListElement>(null);
  const lastId = card.messages.items.at(-1)?.id;

  // К последнему сообщению: при открытии и когда пришло новое (если человек не листает вверх).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (nearBottom || list.dataset['seen'] !== String(card.chat.id)) {
      list.scrollTop = list.scrollHeight;
      list.dataset['seen'] = String(card.chat.id);
    }
  }, [lastId, card.chat.id]);

  let previousDay = '';
  return (
    <ol className="messages" ref={listRef} aria-label="Переписка">
      {card.messages.items.map((message) => {
        const day = dayLabel(message.at, now);
        const showDay = day !== previousDay;
        previousDay = day;
        const { text, placeholder } = messageText(message);
        const side = message.author === 'client' ? 'in' : 'out';
        return (
          <li key={message.id} className="message-item">
            {showDay ? <div className="day">{day}</div> : null}
            <div className={`bubble ${side} ${message.author}`}>
              {message.author === 'client' ? null : <span className="author">{message.authorLabel}</span>}
              {message.kind === 'voice' && !placeholder ? <span className="voice-mark">голосовое, расшифровка</span> : null}
              <p className={placeholder ? 'placeholder' : undefined}>{text}</p>
              <time dateTime={message.at}>{clockTime(message.at, now).replace('вчера ', '')}</time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

interface ComposerProps {
  readonly card: ChatCard;
  readonly botStatus: BotStatus | null;
  readonly onDone: () => void;
}

type Mode = 'reply' | 'return';

interface Outcome {
  readonly tone: 'ok' | 'bad';
  readonly text: string;
}

function replyBlockedReason(botStatus: BotStatus | null): string | null {
  if (botStatus === null) return 'Бот не отвечает: отправить сообщение сейчас нельзя.';
  const { state } = botStatus.whatsapp;
  if (state === 'open') return null;
  if (state === 'disabled') return 'WhatsApp выключен у бота: отправить нельзя.';
  return state === 'connecting' ? 'WhatsApp подключается: подождите минуту.' : 'WhatsApp не подключён: ответ не уйдёт.';
}

export function Composer({ card, botStatus, onDone }: ComposerProps) {
  const [mode, setMode] = useState<Mode>('reply');
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const chatId = card.chat.id;
  const botLeads = card.chat.status === 'bot';

  useEffect(() => {
    setOutcome(null);
    setConfirming(false);
  }, [mode, chatId]);

  const blocked = replyBlockedReason(botStatus);
  const replyLength = text.trim().length;
  const note = composeNote(answer, task);
  const noteLen = noteLength(note);

  const send = async (): Promise<void> => {
    if (botLeads && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(true);
    const result = await apiPost<{ result: string; message: string }>(`/api/chats/${chatId}/reply`, { text: text.trim() });
    setBusy(false);
    if (result.ok) {
      setText('');
      setOutcome({ tone: 'ok', text: result.data.message });
      onDone();
    } else {
      setOutcome({ tone: 'bad', text: result.failure.message });
      if (result.failure.error === 'send_failed') setMode('reply');
    }
  };

  const giveBack = async (): Promise<void> => {
    setBusy(true);
    const result = await apiPost<{ result: string; message: string }>(`/api/chats/${chatId}/return`, { answer: answer.trim(), task: task.trim() });
    setBusy(false);
    if (result.ok) {
      if (result.data.result !== 'already_bot') {
        setAnswer('');
        setTask('');
      }
      setOutcome({ tone: result.data.result === 'already_bot' ? 'bad' : 'ok', text: result.data.message });
      onDone();
    } else {
      setOutcome({ tone: 'bad', text: result.failure.message });
    }
  };

  return (
    <div className="composer">
      <div className="segmented" role="tablist" aria-label="Что сделать">
        <button type="button" role="tab" aria-selected={mode === 'reply'} onClick={() => setMode('reply')}>Ответить клиенту</button>
        <button type="button" role="tab" aria-selected={mode === 'return'} onClick={() => setMode('return')}>Вернуть боту</button>
      </div>

      {mode === 'reply' ? (
        <form
          className="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="visually-hidden" htmlFor="reply-text">Сообщение клиенту</label>
          <textarea
            id="reply-text"
            rows={2}
            maxLength={REPLY_MAX}
            value={text}
            placeholder="Сообщение клиенту от имени номера"
            onChange={(event) => setText(event.target.value)}
            disabled={blocked !== null}
          />
          <div className="composer-bar">
            <p className="composer-hint">
              {blocked ?? (botLeads ? 'Чат ведёт бот: после ответа он перейдёт к вам, бот в нём замолчит.' : 'Чат у менеджера, бот в нём молчит.')}
            </p>
            {confirming ? (
              <div className="confirm">
                <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>Отмена</button>
                <button type="submit" className="btn primary" disabled={busy}>Отправить, бот замолчит</button>
              </div>
            ) : (
              <button type="submit" className="btn primary" disabled={busy || blocked !== null || replyLength === 0}>
                Отправить
              </button>
            )}
          </div>
        </form>
      ) : (
        <form
          className="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void giveBack();
          }}
        >
          <div className="field">
            <label htmlFor="return-answer">Ответ клиенту</label>
            <textarea id="return-answer" rows={2} value={answer} placeholder="Что бот передаст клиенту: «ориентир от 3 млн тенге, нужен выезд»" onChange={(event) => setAnswer(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="return-task">Задание боту</label>
            <textarea id="return-task" rows={2} value={task} placeholder="Что бот должен узнать или сделать: «узнай число ворот и марку 1С»" onChange={(event) => setTask(event.target.value)} />
          </div>
          <div className="composer-bar">
            <p className="composer-hint">
              Бот может пересказать заметку клиенту: без скидок, маржи и внутренних указаний. Цифры он назовёт только
              из заметки. Заметка действует до следующей передачи.
            </p>
            <span className={`num note-count${noteLen > NOTE_MAX ? ' over' : ''}`}>{noteLen} / {NOTE_MAX}</span>
            <button type="submit" className="btn primary" disabled={busy || botLeads || noteLen > NOTE_MAX}>
              Вернуть боту
            </button>
          </div>
          {botLeads ? <p className="composer-hint">Чат уже ведёт бот.</p> : null}
        </form>
      )}

      {outcome ? (
        <p className={`outcome ${outcome.tone}`} role={outcome.tone === 'bad' ? 'alert' : 'status'}>
          {outcome.text}
        </p>
      ) : null}
    </div>
  );
}
