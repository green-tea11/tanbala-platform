import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень проекта. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Папка с исходниками. */
export const SRC = join(ROOT, 'src');

/** Все .ts-файлы внутри dir: пути от dir с прямыми слешами, по алфавиту. Нет папки: пустой список. */
export function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const walk = (current: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const full = join(current, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.ts') ? [relative(dir, full).split(sep).join('/')] : [];
    });
  return walk(dir).sort();
}
