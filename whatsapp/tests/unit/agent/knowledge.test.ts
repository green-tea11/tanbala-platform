import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadKnowledge } from '../../../src/agent/knowledge.js';
import { SafeError } from '../../../src/shared/safe-error.js';

const PATH = 'C:/tanbala/knowledge/bot.md';
const TEXT = '\uFEFF# Tanbala: что знает бот в WhatsApp\n\n## Нельзя\n\n- цены;\n\n';

function reader(files: Readonly<Record<string, string>>) {
  const read: string[] = [];
  const readText = (path: string): Promise<string> => {
    read.push(path);
    const text = files[path];
    return text === undefined
      ? Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }))
      : Promise.resolve(text);
  };
  return { read, readText };
}

async function versionOf(text: string): Promise<string> {
  return (await loadKnowledge(PATH, reader({ [PATH]: text }).readText)).version;
}

describe('loadKnowledge', () => {
  it('читает файл знаний целиком, байт в байт, без обрезки', async () => {
    const { read, readText } = reader({ [PATH]: TEXT });

    const knowledge = await loadKnowledge(PATH, readText);

    expect(knowledge.text).toBe(TEXT);
    expect(read).toEqual([PATH]);
  });

  it('version: sha256 текста; меняется при любой правке', async () => {
    const version = await versionOf(TEXT);

    expect(version).toMatch(/^[0-9a-f]{64}$/);
    expect(await versionOf(TEXT)).toBe(version);
    expect(await versionOf(`${TEXT} `)).not.toBe(version);
  });

  it.each([
    ['пустой', ''],
    ['из одних пробелов', ' \n\t\n'],
  ])('%s файл знаний => понятная ошибка с именем файла', async (_name, empty) => {
    const failure = loadKnowledge(PATH, reader({ [PATH]: empty }).readText);

    await expect(failure).rejects.toBeInstanceOf(SafeError);
    await expect(failure).rejects.toThrow('bot.md');
  });

  it('отсутствующий файл => понятная ошибка с именем файла, причина сохранена в cause', async () => {
    const error = await loadKnowledge(PATH, reader({}).readText).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafeError);
    expect((error as Error).message).toContain('bot.md');
    expect((error as Error).cause).toMatchObject({ code: 'ENOENT' });
  });
});

describe('knowledge/bot.md (просьба владельца 03.11.2026: коротко и по делу)', () => {
  const text = readFileSync(new URL('../../../knowledge/bot.md', import.meta.url), 'utf8');

  it('не длиннее 6000 знаков: вместе с инструкцией ответа не больше 10 тысяч', () => {
    expect([...text].length).toBeLessThanOrEqual(6000);
  });

  it('сильные стороны F1–F10 по номерам: по ним система отмечает рассказанное', () => {
    for (let n = 1; n <= 10; n += 1) expect(text).toMatch(new RegExp(`^- F${n}\\. `, 'mu'));
  });

  it('то, что владелец просил рассказать: 1С есть или нет, веб-интерфейс, антенны, сканер, прибор для записи', () => {
    expect(text).toContain(
      'Если 1С у клиента есть, подключаемся к ней, детали зависят от конфигурации. Если нет, поставим её.',
    );
    expect(text).toContain('веб-интерфейс, где видно, что пришло, что ушло и что где лежит');
    expect(text).toContain('Антенны на входе и выходе сами отмечают, что пришло и что ушло');
    expect(text).toContain('со сканером проходит за пару часов');
    expect(text).toContain('прибор записывает его код в метку');
  });

  it('запреты на месте: цены, сроки, обещания за другого, решение под клиента, модели, гарантии', () => {
    expect(text).toContain('- цены, скидки, акции, «бесплатно», пробный период, образцы');
    expect(text).toContain('- сроки внедрения и поставки, время ответа;');
    expect(text).toContain('- обещать за другого человека');
    expect(text).toContain(
      '- решение под клиента: какие метки и оборудование, сколько и где ставить',
    );
    expect(text).toContain('- модели, бренды, частоты, виды меток');
    expect(text).toContain('- гарантии');
  });
});
