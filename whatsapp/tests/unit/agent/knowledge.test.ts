import { describe, expect, it } from 'vitest';
import { loadKnowledge } from '../../../src/agent/knowledge.js';
import { SafeError } from '../../../src/shared/safe-error.js';

const PATHS = {
  owner: 'C:/tanbala/knowledge/tanbala-agent.md',
  whatsapp: 'C:/tanbala/knowledge/whatsapp.md',
} as const;

const OWNER = '\uFEFF# Tanbala: что должен знать агент\n\nРаздел 11. Строго нельзя.\n\n';
const WHATSAPP = '# Tanbala в WhatsApp\n\n- Длина ответа: одна или две фразы.\n';

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

async function versionOf(owner: string, whatsapp: string): Promise<string> {
  const { readText } = reader({ [PATHS.owner]: owner, [PATHS.whatsapp]: whatsapp });
  return (await loadKnowledge(PATHS, readText)).version;
}

describe('loadKnowledge', () => {
  it('читает оба файла целиком, байт в байт, без обрезки', async () => {
    const { read, readText } = reader({ [PATHS.owner]: OWNER, [PATHS.whatsapp]: WHATSAPP });

    const knowledge = await loadKnowledge(PATHS, readText);

    expect(knowledge.owner).toBe(OWNER);
    expect(knowledge.whatsapp).toBe(WHATSAPP);
    expect([...read].sort()).toEqual([PATHS.owner, PATHS.whatsapp].sort());
  });

  it('version: sha256 обоих текстов; меняется при любой правке и от перестановки файлов', async () => {
    const version = await versionOf(OWNER, WHATSAPP);

    expect(version).toMatch(/^[0-9a-f]{64}$/);
    expect(await versionOf(OWNER, WHATSAPP)).toBe(version);
    expect(await versionOf(`${OWNER} `, WHATSAPP)).not.toBe(version);
    expect(await versionOf(OWNER, `${WHATSAPP}.`)).not.toBe(version);
    expect(await versionOf(WHATSAPP, OWNER)).not.toBe(version);
    expect(await versionOf('ab', 'c')).not.toBe(await versionOf('a', 'bc'));
  });

  it.each([
    ['пустой', ''],
    ['из одних пробелов', ' \n\t\n'],
  ])('%s файл знаний => понятная ошибка с именем файла', async (_name, empty) => {
    const { readText } = reader({ [PATHS.owner]: OWNER, [PATHS.whatsapp]: empty });

    const failure = loadKnowledge(PATHS, readText);

    await expect(failure).rejects.toBeInstanceOf(SafeError);
    await expect(failure).rejects.toThrow('whatsapp.md');
  });

  it('отсутствующий файл => понятная ошибка с именем файла, причина сохранена в cause', async () => {
    const { readText } = reader({ [PATHS.whatsapp]: WHATSAPP });

    const error = await loadKnowledge(PATHS, readText).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafeError);
    expect((error as Error).message).toContain('tanbala-agent.md');
    expect((error as Error).cause).toMatchObject({ code: 'ENOENT' });
  });
});
