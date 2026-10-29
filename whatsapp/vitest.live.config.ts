import { defineConfig } from 'vitest/config';

// Живой прогон диалогов на настоящих моделях (tests/live): платный, только вручную, в npm run check не входит.
// Запуск: LIVE_DIALOG=<путь к JSON> LIVE_OUT=<папка отчёта> npx vitest run --config vitest.live.config.ts
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.ts'],
    testTimeout: 15 * 60_000,
    hookTimeout: 60_000,
  },
});
