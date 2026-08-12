import tsParser from '@typescript-eslint/parser';

export default [
    {
        files: ['src/**/*.ts'],
        ignores: ['src/types/**/*.d.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 'latest',
                sourceType: 'module'
            }
        },
        rules: {
            'no-console': ['error', { allow: ['error', 'warn'] }]
        }
    }
];
