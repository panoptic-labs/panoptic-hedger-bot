/** @type {import('eslint').Linter.Config} */

module.exports = {
  extends: ['./.eslintrc.base.cjs'],
  ignorePatterns: ['.github/**/*'],
  rules: {
    'no-console': 'off',
  },
}
