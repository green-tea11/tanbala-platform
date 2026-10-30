import { describe, expect, it } from 'vitest';
import { loadKnowledge } from '../../../src/agent/knowledge.js';
import { SafeError } from '../../../src/shared/safe-error.js';

const PATHS = {
  owner: 'C:/tanbala/knowledge/tanbala-agent.md',
  whatsapp: 'C:/tanbala/knowledge/whatsapp.md',
  consult: 'C:/tanbala/knowledge/consult.md',
} as const;

const OWNER = '\uFEFF# Tanbala: что должен знать агент\n\nРаздел 11. Строго нельзя.\n\n';
const WHATSAPP = '# Tanbala в WhatsApp\n\n- Длина ответа: одна или две фразы.\n';
const CONSULT = '# Tanbala в WhatsApp: как консультировать\n\n- Сначала боль, потом плюс.\n';

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

async function versionOf(
  owner: string,
  whatsapp: string,
  consult: string = CONSULT,
): Promise<string> {
  const { readText } = reader({
    [PATHS.owner]: owner,
    [PATHS.whatsapp]: whatsapp,
    [PATHS.consult]: consult,
  });
  return (await loadKnowledge(PATHS, readText)).version;
}

const ALL_FILES = { [PATHS.owner]: OWNER, [PATHS.whatsapp]: WHATSAPP, [PATHS.consult]: CONSULT };

describe('loadKnowledge', () => {
  it('читает все три файла целиком, байт в байт, без обрезки', async () => {
    const { read, readText } = reader(ALL_FILES);

    const knowledge = await loadKnowledge(PATHS, readText);

    expect(knowledge.owner).toBe(OWNER);
    expect(knowledge.whatsapp).toBe(WHATSAPP);
    expect(knowledge.consult).toBe(CONSULT);
    expect([...read].sort()).toEqual([PATHS.owner, PATHS.whatsapp, PATHS.consult].sort());
  });

  it('version: sha256 всех трёх текстов; меняется при любой правке и от перестановки файлов', async () => {
    const version = await versionOf(OWNER, WHATSAPP);

    expect(version).toMatch(/^[0-9a-f]{64}$/);
    expect(await versionOf(OWNER, WHATSAPP)).toBe(version);
    expect(await versionOf(`${OWNER} `, WHATSAPP)).not.toBe(version);
    expect(await versionOf(OWNER, `${WHATSAPP}.`)).not.toBe(version);
    expect(await versionOf(OWNER, WHATSAPP, `${CONSULT}.`)).not.toBe(version);
    expect(await versionOf(WHATSAPP, OWNER)).not.toBe(version);
    expect(await versionOf(OWNER, CONSULT, WHATSAPP)).not.toBe(version);
    expect(await versionOf('ab', 'c')).not.toBe(await versionOf('a', 'bc'));
  });

  it.each([
    ['пустой', ''],
    ['из одних пробелов', ' \n\t\n'],
  ])('%s файл знаний => понятная ошибка с именем файла', async (_name, empty) => {
    const { readText } = reader({ ...ALL_FILES, [PATHS.consult]: empty });

    const failure = loadKnowledge(PATHS, readText);

    await expect(failure).rejects.toBeInstanceOf(SafeError);
    await expect(failure).rejects.toThrow('consult.md');
  });

  it('отсутствующий файл => понятная ошибка с именем файла, причина сохранена в cause', async () => {
    const { readText } = reader({ [PATHS.whatsapp]: WHATSAPP, [PATHS.consult]: CONSULT });

    const error = await loadKnowledge(PATHS, readText).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafeError);
    expect((error as Error).message).toContain('tanbala-agent.md');
    expect((error as Error).cause).toMatchObject({ code: 'ENOENT' });
  });
});
