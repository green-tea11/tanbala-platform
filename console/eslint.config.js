import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'data/', 'node_modules/', 'web/'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Логи только через pino: console может вывести пароль, токен или текст клиента
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
