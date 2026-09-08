'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = path.join(root, 'node_modules/dompurify/dist/purify.min.js');
const target = path.join(root, 'renderer/vendor/purify.js');
if (process.argv.includes('--check')) {
  if (!fs.readFileSync(source).equals(fs.readFileSync(target))) {
    throw new Error('The shipped DOMPurify differs from the installed version. Run npm run vendor:sync.');
  }
} else {
  fs.copyFileSync(source, target);
}
