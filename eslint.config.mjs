import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'reports/', 'tmp/', 'node_modules/'] },
  ...tseslint.configs.recommended,
);
