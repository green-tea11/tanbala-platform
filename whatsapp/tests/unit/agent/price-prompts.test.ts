import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Knowledge } from '../../../src/agent/knowledge.js';
import { buildSystem } from '../../../src/agent/prompts.js';

const KNOWLEDGE: Knowledge = {
  owner: '# Tanbala: что должен знать агент\n\nЦены не называй.\n',
  whatsapp: '# Tanbala в WhatsApp\n\nОдна или две фразы.\n',
  version: 'v1',
};

/** Фраза владельца от 27.10.2026 при передаче чата после вопроса цены. */
const PRICE_HANDOFF = 'Цена сильно зависит от объёма. Уточню у коллеги и вернусь к вам.';

function instruction(purpose: 'review' | 'interest'): string {
  return buildSystem(KNOWLEDGE, purpose).at(-1)?.text ?? '';
}

describe('вопрос цены: проверка и оценка интереса', () => {
  it('проверка не отклоняет вопрос о недостающем для передачи по цене и пояснение про ориентир коллеги', () => {
    const text = instruction('review');
    expect(text).toMatch(
      /в обычном ответе о цене: «цена сильно зависит от объёма», один вопрос о том, чего не хватает для передачи[^\n]*«это нужно, чтобы коллега сразу назвал ориентир»/,
    );
  });

  it('проверка не отклоняет «цена сильно зависит от объёма» и фразу передачи владельца', () => {
    const text = instruction('review');
    expect(text).toMatch(/без чисел [^\n]*«цена сильно зависит от объёма»/);
    expect(text).toContain(`в сообщении о передаче «${PRICE_HANDOFF}»`);
  });

  it('оценка интереса: первый вопрос цены без задачи hot не даёт, третий вопрос и отказ отвечать дают', () => {
    const text = instruction('interest');
    expect(text).toMatch(
      /hot: клиент согласился, что трудность у него есть, или рассказал о своей задаче/,
    );
    expect(text).toMatch(
      /или спрашивает цену третий раз; или отказывается отвечать на вопросы и спрашивает цену; или просит живого человека/,
    );
    expect(text).not.toMatch(/второй раз/);
    expect(text).toMatch(
      /Первый вопрос цены без рассказа о задаче и без согласия, что трудность есть, hot не даёт/,
    );
  });

  it('оценка интереса: поля минимума и сигналы последних сообщений клиента', () => {
    const text = instruction('interest');
    expect(text).toMatch(/oneCName: какая у клиента 1С/);
    expect(text).toMatch(/problemAgreed: true, если клиент согласился, что трудность у него есть/);
    expect(text).toMatch(/priceAsked: true, если в них клиент спрашивает цену/);
    expect(text).toMatch(/refused: true, если в них клиент отказывается отвечать/);
  });
});

describe('knowledge/whatsapp.md: один голос (решение владельца 29.10.2026)', () => {
  const whatsapp = readFileSync(new URL('../../../knowledge/whatsapp.md', import.meta.url), 'utf8');

  it('клиенту сотрудник Tanbala это «коллега», фраза передачи «Уточню у коллеги и вернусь к вам»', () => {
    expect(whatsapp).toMatch(/Клиенту менеджера называй коллегой/);
    expect(whatsapp).toContain('«Уточню у коллеги и вернусь к вам.»');
    expect(whatsapp).not.toMatch(/Передал ваш вопрос|Передал вопрос|передал специалисту/);
    // «он вам напишет» только как запрет: «не «он вам напишет»».
    expect(whatsapp.match(/он вам напишет/g)).toHaveLength(1);
    expect(whatsapp).toContain('не «он вам напишет»');
  });

  it('«специалист» только в цитате документа и в правиле одного голоса', () => {
    const lines = whatsapp.split('\n').filter((line) => /специалист/.test(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('«расскажет специалист в WhatsApp»');
    expect(lines[1]).toMatch(/Слово «специалист» из документа клиенту не пиши/);
  });
});

describe('knowledge/whatsapp.md: вопрос цены', () => {
  const whatsapp = readFileSync(new URL('../../../knowledge/whatsapp.md', import.meta.url), 'utf8');

  it('минимум перед передачей по цене (решение владельца 29.10.2026): пять пунктов', () => {
    expect(whatsapp).toContain('### Вопрос цены');
    expect(whatsapp).toMatch(/Перед передачей по цене коллеге нужен минимум/);
    for (const item of [
      '1. Что учитывать: только ввоз и вывоз или где лежит каждая вещь.',
      '2. Примерное число вещей.',
      '3. Есть ли 1С и какая, если клиент знает.',
      '4. Название компании.',
      '5. Клиент согласился, что трудность у него есть, или сам рассказал о своей задаче.',
    ]) {
      expect(whatsapp).toContain(item);
    }
  });

  it('цена без минимума: ответ из знаний, цена зависит от объёма, один вопрос и зачем; с минимумом передача', () => {
    expect(whatsapp).toMatch(/Клиент спросил цену, а минимума нет: чат не передавай/);
    expect(whatsapp).toMatch(
      /задай один недостающий вопрос, объяснив зачем: «чтобы коллега сразу назвал ориентир»/,
    );
    expect(whatsapp).toMatch(/Один вопрос за сообщение, без анкеты/);
    expect(whatsapp).toContain(
      `Минимум собран, и клиент спрашивает цену: напиши «${PRICE_HANDOFF}» и передай чат`,
    );
  });

  it('сразу без минимума: просьба о человеке, отказ отвечать, третий вопрос цены, жалоба; второй раз больше не повод', () => {
    expect(whatsapp).toMatch(
      /Без минимума передавай чат сразу, только если клиент прямо просит живого человека, отказывается отвечать на вопросы, спрашивает цену в третий раз или жалуется/,
    );
    expect(whatsapp).not.toMatch(/второй раз/);
  });

  it('уровни и «Что писать клиенту» согласованы с правилами цены', () => {
    expect(whatsapp).toMatch(/- Горячий: клиент согласился, что трудность у него есть/);
    expect(whatsapp).toContain(`- Клиент спрашивал цену: «${PRICE_HANDOFF}»`);
    expect(whatsapp).toMatch(/На вопрос «сколько стоит» действуй по правилам «Вопрос цены»/);
  });

  it('уведомление менеджеру: компания или «не определена», ссылка на карточку, подтверждённые трудности', () => {
    expect(whatsapp).toMatch(
      /компанию клиента \(или «не определена»\) со ссылкой на её карточку и трудности, которые клиент подтвердил/,
    );
  });

  it('уведомление менеджеру: что из минимума для цены собрано и что выяснить не удалось', () => {
    expect(whatsapp).toMatch(/что из минимума для цены собрано и что выяснить не удалось/);
  });

  it('без тире', () => {
    expect(whatsapp).not.toMatch(/[\u2012-\u2015\u2212]/);
  });
});

describe('knowledge/whatsapp.md: возврат чата боту (решение владельца 29.10.2026)', () => {
  const whatsapp = readFileSync(new URL('../../../knowledge/whatsapp.md', import.meta.url), 'utf8');

  it('после возврата бот отвечает на неотвеченное не старше 12 часов, если менеджер не ответил', () => {
    expect(whatsapp).toMatch(
      /Когда чат вернули, ты отвечаешь и на сообщения клиента, которые пришли после последнего ответа твоего или менеджера, если им не больше 12 часов/,
    );
    expect(whatsapp).toMatch(/одним сообщением/);
  });
});
