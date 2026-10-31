import { LevelPill, Panel, Unavailable } from '../components/Bits';
import { IconExternal } from '../components/Icons';
import { clockTime, lowerFirst, safeExternalUrl } from '../lib/format';
import { Link } from '../lib/router';
import { isUnavailable, type CalcState, type ClientCard, type ChatCard, type LeadsCompanyCard, type Pain } from '../lib/types';

/** Для расчёта: всё известно или чего не хватает; известное по выводу помечено «вероятно». */
function CalcLine({ calc }: { readonly calc: CalcState }) {
  const known = calc.known.map((item) => (item.inferred ? `${item.label} (вероятно)` : item.label));
  return (
    <p className="facts-inline">
      {calc.missing.length === 0 ? (
        <b>Для расчёта известно всё.</b>
      ) : (
        <>
          <b>Для расчёта не хватает:</b> {calc.missing.map((item) => item.label).join(', ')}.
        </>
      )}
      {calc.missing.length > 0 && known.length > 0 ? <span className="muted"> Известно: {known.join(', ')}.</span> : null}
    </p>
  );
}

/** Что выяснил бот: оценка интереса и выжимка; невыясненное — одной строкой. */
export function BotFacts({ card, now }: { readonly card: ChatCard; readonly now: number }) {
  const known = card.profile.fields.filter((field) => field.value !== null && field.value !== '');
  const unknown = card.profile.fields.filter((field) => field.value === null || field.value === '');
  return (
    <Panel id="facts" title="Что выяснил бот" aside={card.profile.updatedAt ? <span>оценка {clockTime(card.profile.updatedAt, now)}</span> : null}>
      <div className="level-line">
        <LevelPill level={card.chat.level} />
        <span>{card.profile.levelReason ?? 'Причина оценки не записана.'}</span>
      </div>
      {card.profile.calc ? <CalcLine calc={card.profile.calc} /> : null}
      {card.chat.toldFacts && card.chat.toldFacts.length > 0 ? (
        <p className="facts-inline muted">Рассказано клиенту: {card.chat.toldFacts.map((fact) => fact.label).join(', ')}.</p>
      ) : null}
      {card.profile.problemAgreed || card.chat.priceAsks > 0 ? (
        <p className="facts-inline muted">
          {card.profile.problemAgreed ? 'Клиент согласен, что трудность есть.' : null}
          {card.chat.priceAsks > 0 ? ` Вопросов о цене: ${card.chat.priceAsks}.` : null}
        </p>
      ) : null}
      {known.length > 0 ? (
        <dl className="kv">
          {known.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>
                {field.value}
                {field.inferred ? <span className="muted"> · вероятно</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="empty">Бот пока ничего не выяснил.</p>
      )}
      {unknown.length > 0 ? <p className="facts-inline muted">Не выяснено: {unknown.map((f) => lowerFirst(f.label)).join(', ')}.</p> : null}
      {card.note ? (
        <p className="bot-note">
          <b>Заметка для бота</b> · {clockTime(card.note.at, now)}
          <br />
          {card.note.text}
        </p>
      ) : null}
    </Panel>
  );
}

function LeadsData({ leads, now }: { readonly leads: LeadsCompanyCard; readonly now: number }) {
  const { company, qualification } = leads;
  const twoGis = safeExternalUrl(company.sourceUrl);
  const site = safeExternalUrl(company.website);
  return (
    <>
      <p className="company-meta">
        {[company.rubric, company.cityName, company.branchesCount ? `филиалов ${company.branchesCount}` : null].filter(Boolean).join(' · ')}
      </p>
      {qualification ? (
        <div className="fit">
          <span className="num fit-score">{qualification.score ?? '—'}</span>
          <span className="fit-of">из 100</span>
          <div className="fit-text">
            <b>{qualification.fitLabel ?? 'не оценена'}</b>
            {qualification.segment ? <span className="muted"> · {qualification.segment}</span> : null}
            {qualification.reason ? <p>{qualification.reason}</p> : null}
          </div>
        </div>
      ) : (
        <p className="empty">Почта ещё не оценила компанию.</p>
      )}
      {company.requestedVia === 'whatsapp' ? <p className="pill note wrap-pill">Компанию добавила проверка из WhatsApp: в рассылку она не попадает.</p> : null}
      {leads.blocked ? <p className="pill bad wrap-pill">В списке «не писать»: письма этой компании одобрить нельзя.</p> : null}
      <div className="links">
        <Link to={`/companies/${company.id}`} className="text-link">Карточка компании</Link>
        {twoGis ? <a className="text-link" href={twoGis} target="_blank" rel="noopener noreferrer">2ГИС <IconExternal size={12} /></a> : null}
        {site ? <a className="text-link" href={site} target="_blank" rel="noopener noreferrer">сайт <IconExternal size={12} /></a> : null}
      </div>
      <span className="visually-hidden">{clockTime(company.whatsappContactedAt, now)}</span>
    </>
  );
}

/** Фирменный блок: что почта нашла о болях на сайте и в 2ГИС — рядом с тем, что клиент сказал сам. */
function PainsSideBySide({ found, said }: { readonly found: readonly Pain[]; readonly said: readonly string[] }) {
  return (
    <div className="pains">
      <div>
        <h3>Почта нашла</h3>
        {found.length === 0 ? (
          <p className="muted">Подтверждённых болей нет.</p>
        ) : (
          <ul>
            {found.map((pain) => (
              <li key={pain.pain}>
                <b>{pain.pain}</b>
                <span className="evidence"><q>{pain.evidence}</q> · {pain.sourceLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3>Клиент сказал</h3>
        {said.length === 0 ? (
          <p className="muted">Пока ничего не подтвердил.</p>
        ) : (
          <ul>
            {said.map((pain) => (
              <li key={pain}>
                <b>{pain}</b>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function CompanyFacts({ client, now }: { readonly client: ClientCard; readonly now: number }) {
  const bot = client.chat.company;
  const leads = client.company?.leads;
  const title = bot.confirmed?.name ?? bot.candidate?.name ?? bot.statedName ?? 'Компания';
  const confirmed = client.company?.confirmed ?? false;
  const leadsCard = leads && !isUnavailable(leads) && !('notFound' in leads) ? leads : null;
  return (
    <Panel id="company" title="Компания" aside={<span className={`pill ${confirmed ? 'ok' : bot.state === 'candidate' ? 'note' : 'neutral'}`}>{bot.stateLabel}</span>}>
      {bot.confirmed || bot.candidate ? <p className="company-name">{title}</p> : null}
      {bot.state === 'candidate' && bot.candidate ? (
        <p className="facts-inline">Бот нашёл кандидата {bot.candidate.sourceLabel}; клиент ещё не подтвердил, что это его компания.</p>
      ) : null}
      {bot.state === 'unknown' || bot.state === 'off' || bot.state === 'not_read' ? (
        <p className="empty">{bot.statedName ? `Клиент назвал «${bot.statedName}», в почтовой базе не найдено.` : 'Компания клиента не определена.'}</p>
      ) : null}
      {/* Итог проверки нужен, пока компания не найдена: после кандидата или подтверждения он про прежнее название. */}
      {bot.research && !bot.confirmed && !bot.candidate ? <p className="facts-inline muted">Проверка новой компании: {bot.research.label}.</p> : null}
      {leads && isUnavailable(leads) ? <Unavailable source="leads" /> : null}
      {leads && 'notFound' in leads ? <p className="empty">{leads.message}</p> : null}
      {leadsCard ? <LeadsData leads={leadsCard} now={now} /> : null}
      {bot.confirmed || leadsCard ? <PainsSideBySide found={leadsCard?.pains ?? bot.confirmed?.pains ?? []} said={bot.confirmedPains} /> : null}
    </Panel>
  );
}

export function LettersFacts({ client, now }: { readonly client: ClientCard; readonly now: number }) {
  const leads = client.company?.leads;
  const card = leads && !isUnavailable(leads) && !('notFound' in leads) ? leads : null;
  if (card === null) return null;
  return (
    <Panel id="letters" title="Письма компании" count={card.history.length + (card.draft ? 1 : 0)}>
      {card.draft ? (
        <Link to={`/letters/${card.draft.id}`} className="row-link">
          <div className="row compact-row">
            <div className="row-main">
              <div className="row-line1"><span className="who">{card.draft.subject}</span></div>
              <div className="row-line2">
                Черновик: {card.draft.reviewLabel.toLowerCase()}
                {card.draft.approvedAt ? ` ${clockTime(card.draft.approvedAt, now)}${card.draft.approvedBy ? `, ${card.draft.approvedBy}` : ''}` : ''}
              </div>
            </div>
          </div>
        </Link>
      ) : null}
      {card.history.length === 0 ? (
        <p className="empty">{card.draft ? 'Отправленных писем ещё не было.' : 'Этой компании ещё не писали.'}</p>
      ) : (
        <ul className="rows history">
          {card.history.map((item) => (
            <li key={item.id} className="history-row">
              <span className="num">{clockTime(item.occurredAt, now)}</span>
              <span>{item.whatLabel}{item.subject ? `: ${item.subject}` : ''}</span>
              <span className="muted">{item.sourceLabel} · {item.email}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function HandoffFacts({ card, now }: { readonly card: ChatCard; readonly now: number }) {
  return (
    <Panel id="handoff" title="Передачи и уведомления" count={card.handoffs.length}>
      {card.handoffs.length === 0 ? (
        <p className="empty">Бот этот чат не передавал.</p>
      ) : (
        <ul className="rows">
          {card.handoffs.map((h) => (
            <li key={h.id} className="history-row">
              <span className="num">{clockTime(h.openedAt, now)}</span>
              <span>{h.reasonLabel}</span>
              <span className="muted">{h.resolvedAt ? `возвращён ${clockTime(h.resolvedAt, now)}` : 'открыта'}</span>
            </li>
          ))}
        </ul>
      )}
      {card.lastNotification ? (
        <p className="facts-inline">
          Уведомление менеджеру: <span className={`pill ${['sent', 'pending'].includes(card.lastNotification.status) ? 'neutral' : 'bad'}`}>{card.lastNotification.statusLabel}{card.lastNotification.attempts > 1 ? ` · ${card.lastNotification.attempts} попыток` : ''}</span>
        </p>
      ) : null}
      {card.rejected.total > 0 ? (
        <details className="rejected">
          <summary>Отклонённые черновики бота: {card.rejected.total}</summary>
          <ul>
            {card.rejected.items.map((item) => (
              <li key={item.at}>
                <p className="muted">{clockTime(item.at, now)} · попытка {item.attempt} · {item.sourceLabel}</p>
                <p>{item.draft}</p>
                <p className="remarks">{item.remarks.join('; ')}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}
