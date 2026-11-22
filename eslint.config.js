import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

const recommendedRules = reactHooks.configs.flat['recommended-latest'].rules

export default [
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser },
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { noInlineConfig: true },
    // Treat new compiler diagnostics and both Rules of Hooks checks as errors.
    rules: Object.fromEntries(Object.keys(recommendedRules).map((rule) => [rule, 'error'])),
  },
]
