import { useState } from 'react';
import { LevelPill, ModeBanner, Skeleton, Unavailable } from '../components/Bits';
import { IconPhone } from '../components/Icons';
import { nameOf, phoneLabel, telHref, waHref } from '../lib/format';
import { Link } from '../lib/router';
import { usePoll } from '../lib/usePoll';
import { isUnavailable, type BotStatus, type ClientCard, type Home, type Section } from '../lib/types';
import { Composer, Messages } from './ClientConversation';
import { BotFacts, CompanyFacts, HandoffFacts, LettersFacts } from './ClientFacts';

const CHAT_POLL_MS = 5_000;

type Tab = 'chat' | 'client' | 'company';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'chat', label: 'Переписка' },
  { id: 'client', label: 'О клиенте' },
  { id: 'company', label: 'Компания' },
];

interface ClientScreenProps {
  readonly chatId: number;
  readonly home: Home | null;
}

export function ClientScreen({ chatId, home }: ClientScreenProps) {
  const poll = usePoll<Section<ClientCard>>(`/api/clients/${chatId}`, CHAT_POLL_MS);
  const [tab, setTab] = useState<Tab>('chat');
  const now = poll.updatedAt ?? Date.now();
  const botStatus: BotStatus | null = home && !isUnavailable(home.botStatus) ? home.botStatus : null;

  if (poll.error?.error === 'not_found') {
    return (
      <div className="sheet-inner">
        <div className="title-row"><div><h1>Чат не найден</h1><p className="finding muted">Чат могли объединить с другим чатом того же клиента. <Link to="/chats" className="text-link">К списку чатов</Link></p></div></div>
      </div>
    );
  }
  const data = poll.data;
  if (data === null) {
    return (
      <div className="sheet-inner" aria-busy="true">
        <div className="title-row"><div><Skeleton width={240} height={28} /><p className="finding"><Skeleton width={320} /></p></div></div>
      </div>
    );
  }
  if (isUnavailable(data)) {
    return (
      <div className="sheet-inner">
        <div className="title-row"><div><h1>Клиент</h1></div></div>
        <Unavailable source="wa" />
      </div>
    );
  }

  const { chat } = data.chat;
  const phone = phoneLabel(chat.phone);
  const tel = telHref(chat.phone);
  const wa = waHref(chat.phone);
  const companyName = data.chat.company.confirmed?.name ?? data.chat.company.candidate?.name ?? null;

  return (
    <div className="sheet-inner client" data-tab={tab}>
      {home ? <ModeBanner mode={home.mode} /> : null}
      <div className="title-row client-head">
        <div className="client-id">
          <nav className="crumbs" aria-label="Путь"><Link to="/chats">Чаты</Link><span aria-hidden="true">/</span></nav>
          <h1>{nameOf(chat.name)}</h1>
          <p className="client-sub">
            {phone ? <span className="mono">{phone}</span> : <span className="muted">номер скрыт</span>}
            <span>{chat.statusLabel}</span>
            <LevelPill level={chat.level} />
            {companyName ? <span className="muted client-company">{companyName}</span> : null}
          </p>
        </div>
        <div className="title-actions">
          {tel ? <a className="btn" href={tel}><IconPhone /> <span className="btn-label">Позвонить</span></a> : null}
          {wa ? <a className="btn" href={wa} target="_blank" rel="noopener noreferrer">WhatsApp</a> : null}
        </div>
      </div>

      <div className="client-tabs segmented" role="tablist" aria-label="Разделы клиента">
        {TABS.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </div>

      <div className="client-grid">
        <section className="panel conversation region-chat" aria-label="Переписка WhatsApp">
          <Messages card={data.chat} now={now} />
          <Composer card={data.chat} botStatus={botStatus} onDone={poll.refresh} />
        </section>
        <div className="client-side">
          <div className="region-client">
            <BotFacts card={data.chat} now={now} />
          </div>
          <div className="region-company">
            <CompanyFacts client={data} now={now} />
            <LettersFacts client={data} now={now} />
          </div>
          <div className="region-client">
            <HandoffFacts card={data.chat} now={now} />
          </div>
        </div>
      </div>
    </div>
  );
}
