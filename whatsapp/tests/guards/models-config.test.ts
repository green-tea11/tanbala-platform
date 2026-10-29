import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(
  readFileSync(new URL('../../config/models.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('config/models.json', () => {
  it('задаёт модели для четырёх вызовов Claude и для расшифровки голосовых', () => {
    expect(Object.keys(config).sort()).toEqual([
      'interest',
      'logo',
      'reply',
      'review',
      'transcribe',
    ]);
  });

  it.each(['reply', 'review', 'interest', 'logo'])(
    'модель для вызова %s похожа на ID Claude',
    (purpose) => {
      expect(config[purpose]).toMatch(/^claude-[a-z0-9-]+$/);
    },
  );

  it('ответ, проверка и оценка интереса на Sonnet, логотип на Haiku (решение 29.10.2026)', () => {
    expect(config.reply).toBe('claude-sonnet-5-5');
    expect(config.review).toBe('claude-sonnet-5-5');
    expect(config.interest).toBe('claude-sonnet-5-5');
    expect(config.logo).toBe('claude-haiku-5-5');
  });

  it('модель расшифровки задана в формате OpenRouter «провайдер/модель»', () => {
    expect(config.transcribe).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
  });
});
