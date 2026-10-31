import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // tools/simulator: инструмент разработки на .mjs вне сборки и tsconfig (README там же), печатает в консоль.
  { ignores: ['dist/', 'coverage/', 'data/', 'node_modules/', 'tools/simulator/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Логи только через pino: console может вывести текст клиента или ключ
      'no-console': 'error',
      // Заготовки модулей пока не используют параметры
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
