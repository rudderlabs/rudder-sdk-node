module.exports = {
  extends: ["airbnb", "prettier"],
  plugins: ["prettier"],

  rules: {
    "prettier/prettier": ["warn"],
    "no-unused-vars": [1, { vars: "local", args: "none" }],
    "no-console": "off",
    "no-var": "off",
    "vars-on-top": "off",
    "func-names": "off",
    "no-plusplus": "off",
    "prefer-destructuring": "off",
    camelcase: "error",
    eqeqeq: "off",
    "no-param-reassign": "off",
    "block-scoped-var": "off",
    "prefer-template": "off",
    "import/no-dynamic-require": "off",
    "global-require": "off",
    "no-underscore-dangle": "off",
    "class-methods-use-this": "off",
    "consistent-return": "off",
    "import/no-extraneous-dependencies": "off"
  }
};
