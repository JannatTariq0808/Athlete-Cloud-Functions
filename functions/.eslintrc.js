module.exports = {
  env: {
    es6: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
  },
  extends: ["eslint:recommended", "google"],
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    "prefer-arrow-callback": "error",
    "quotes": ["error", "double", {allowTemplateLiterals: true}],
    "camelcase": "off",
    "no-tabs": "off",

    "no-mixed-spaces-and-tabs": ["off"],
    "max-len": [
      "error",
      {
        code: 120,
        ignoreUrls: true,
        ignoreComments: false,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
      },
    ],
  },
  overrides: [
    {
      files: ["**/*.spec.*"],
      env: {
        mocha: true,
      },
      rules: {},
    },
  ],
  globals: {},
};
