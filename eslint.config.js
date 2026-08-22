import js from '@eslint/js';
import globals from 'globals';

/**
 * ESLint flat config do servico 3D. Espelha o do ebgeo_360.
 * @see https://eslint.org/docs/latest/use/configure/configuration-files-new
 */
export default [
    js.configs.recommended,

    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2021,
            },
        },

        rules: {
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-console': 'off',          // os scripts de importacao falam pelo console
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'prefer-const': 'error',
            'no-var': 'error',
            'object-shorthand': 'warn',
            'no-await-in-loop': 'off',    // a conversao e sequencial de proposito
        },
    },

    {
        ignores: ['node_modules/**', 'data/**', 'docs/**', 'coverage/**'],
    },
];
