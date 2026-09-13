import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.gjc/', '.paseo/', '.claude/', 'dist/', 'reports/', 'tmp/', 'node_modules/'] },
  ...tseslint.configs.recommended,
);
