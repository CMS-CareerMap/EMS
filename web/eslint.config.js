import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * The §A5 rules (EMS_BUILD_GUIDE.md) that apply in the browser. The server
 * checks all eight with its own `npm run lint`.
 *
 * Rule 7 — no statutory numbers — waits for Day 17, as the guide says: the
 * payroll screens still carry their own copies until they are rewritten.
 */
const ROLE_NAME = '/^(super_admin|admin|hr|manager|rm|accounts|employee)$/'
const role = (path) => `:matches([${path}.name='role'], [${path}.property.name='role'])`

/**
 * Rule 5. A role check hides a button from the wrong people only until the
 * permission moves to another role — then it hides it from the right ones.
 */
const NO_ROLE_CHECKS = [
  {
    selector: `BinaryExpression[operator=/^[!=]==?$/][right.value=${ROLE_NAME}]${role('left')}`,
    message: '§A5 rule 5: do not compare a role — ask can(permission).',
  },
  {
    selector: `BinaryExpression[operator=/^[!=]==?$/][left.value=${ROLE_NAME}]${role('right')}`,
    message: '§A5 rule 5: do not compare a role — ask can(permission).',
  },
  {
    selector: `CallExpression[callee.property.name='includes'][callee.object.elements.0.value=${ROLE_NAME}]${role('arguments.0')}`,
    message: '§A5 rule 5: do not check a role against a list — ask can(permission).',
  },
  {
    selector: `SwitchStatement${role('discriminant')} > SwitchCase[test.value=${ROLE_NAME}]`,
    message: '§A5 rule 5: do not switch on a role — ask can(permission).',
  },
]

/**
 * Rule 8. new Date().toISOString() is the day in UTC, which is yesterday in
 * India until 05:30. Days come from lib/dates.js; so do instants, through
 * isoInstant — one place to look when either is wrong.
 */
const NO_TO_ISO_STRING = {
  selector: "MemberExpression[property.name='toISOString']",
  message: '§A5 rule 8: use calendarDayIn() for a day or isoInstant() for a moment (lib/dates.js).',
}

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      'no-restricted-syntax': ['error', ...NO_ROLE_CHECKS, NO_TO_ISO_STRING],
    },
  },
  {
    // The one file that may call it: it is where the rule is implemented.
    files: ['src/lib/dates.js'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_ROLE_CHECKS],
    },
  },
])
