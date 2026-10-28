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
const PRICE_HANDOFF =
  'Цена сильно зависит от объёма. Передал ваш вопрос специалисту, он вам напишет.';

function instruction(purpose: 'review' | 'interest'): string {
  return buildSystem(KNOWLEDGE, purpose).at(-1)?.text ?? '';
}

describe('вопрос цены: проверка и оценка интереса', () => {
  it('проверка не отклоняет «цена сильно зависит от объёма» и фразу передачи владельца', () => {
    const text = instruction('review');
    expect(text).toMatch(/без чисел «цена сильно зависит от объёма»/);
    expect(text).toContain(`в сообщении о передаче «${PRICE_HANDOFF}»`);
  });

  it('оценка интереса: первый вопрос цены без задачи hot не даёт, цена второй раз даёт', () => {
    const text = instruction('interest');
    expect(text).toMatch(
      /hot: клиент согласился, что трудность у него есть, или рассказал о своей задаче/,
    );
    expect(text).toMatch(
      /или спрашивает цену второй раз либо настаивает; или просит живого человека/,
    );
    expect(text).toMatch(
      /Первый вопрос цены без рассказа о задаче и без согласия, что трудность есть, hot не даёт/,
    );
  });
});

describe('knowledge/whatsapp.md: вопрос цены', () => {
  const whatsapp = readFileSync(new URL('../../../knowledge/whatsapp.md', import.meta.url), 'utf8');

  it('три правила вопроса цены и фраза передачи', () => {
    expect(whatsapp).toContain('### Вопрос цены');
    expect(whatsapp).toMatch(/Клиент спросил цену впервые[^\n]*чат не передавай/);
    expect(whatsapp).toMatch(
      /спроси «Вы из компании X\?», а после ответа напиши одно сообщение о трудности/,
    );
    expect(whatsapp).toContain(`напиши «${PRICE_HANDOFF}» и передай чат`);
    expect(whatsapp).toMatch(/Клиент спрашивает цену второй раз или настаивает: передай чат сразу/);
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
});
