import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Спрашивает git, игнорируется ли путь. Любой сбой git роняет тест, а не проходит молча. */
function isIgnored(path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', path], { cwd: ROOT });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git check-ignore завершился с кодом ${String(result.status)}: ${String(result.stderr)}`,
  );
}

describe('.gitignore', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'server.key',
    'data/whatsapp-session/creds.json',
    'auth_info_baileys/creds.json',
    'baileys_auth_info/creds.json',
    'creds.json',
    'pre-key-1.json',
    'tctoken-1.json',
    'identity-key-1.json',
    'qr.png',
    'data/tanbala.db',
    'data/tanbala.db-wal',
    'data/token-usage.jsonl',
    'backup.db',
    'voice-note.ogg',
    'node_modules/baileys/package.json',
    'dist/cli.js',
    'coverage/index.html',
    '.claude/settings.local.json',
  ])('прячет из git секреты, сессию и данные: %s', (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each([
    '.env.example',
    '.npmrc',
    'package-lock.json',
    'CLAUDE.md',
    'src/cli.ts',
    'config/models.json',
    'knowledge/whatsapp.md',
    'knowledge/tanbala-agent.md',
    'docs/PLAN.md',
  ])('не прячет файлы проекта: %s', (path) => {
    expect(isIgnored(path)).toBe(false);
  });

  it('в индексе git нет файлов, которые должны игнорироваться (защита от git add -f .env)', () => {
    const result = spawnSync('git', ['ls-files', '--cached', '--ignored', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(`git ls-files завершился с кодом ${String(result.status)}`);
    }
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([]);
  });
});
