// ESLint flat config. `npm run lint` had no config at all before this file, so
// the step failed outright and nobody could tell a lint error from a missing
// setup. Kept close to the recommended presets: the point is to catch real
// mistakes (unused bindings, unreachable code, floating `any`s), not to restyle
// the codebase.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      // `_req`, `_next` and friends are required by Express signatures.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
