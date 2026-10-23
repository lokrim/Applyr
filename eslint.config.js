import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules/**', '.wxt/**', '.output/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['wxt*', 'react*', 'idb', '../browser/*', '../storage/*'] }],
      'no-restricted-globals': ['error', 'window', 'document', 'chrome', 'browser', 'fetch', 'indexedDB'],
    },
  },
);
