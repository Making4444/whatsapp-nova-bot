import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUserPrompt,
  parseEditCommand,
  parseLastCount,
  parseMoodCommand,
  parseSetCommand,
} from '../src/utils/text.js';

test('extractUserPrompt detects يا نوفا and ي نوفا in any position', () => {
  assert.equal(extractUserPrompt('يا نوفا عامل ايه'), 'عامل ايه');
  assert.equal(extractUserPrompt('لو سمحت ي نوفا شوف دي'), 'لو سمحت شوف دي');
  assert.equal(extractUserPrompt('بقينا لوحدينا يا نوفا رد'), 'بقينا لوحدينا رد');
  assert.equal(extractUserPrompt('مفيش نداء هنا'), null);
});

test('parseLastCount supports Arabic numbers and wording', () => {
  assert.equal(parseLastCount('ايه اخر 100 رساله'), 100);
  assert.equal(parseLastCount('إيه اخر ٣٥ رساله'), 35);
  assert.equal(parseLastCount('ايه اخر رساله'), null);
});

test('parseEditCommand parses /edit all and numeric values', () => {
  assert.deepEqual(parseEditCommand('/edit all'), { type: 'all' });
  assert.deepEqual(parseEditCommand('/edit 200'), { type: 'count', count: 200 });
  assert.deepEqual(parseEditCommand('/edit ١٥٠'), { type: 'count', count: 150 });
  assert.equal(parseEditCommand('/edit 0'), null);
});

test('parseMoodCommand supports show and set', () => {
  assert.deepEqual(parseMoodCommand('/mood'), { type: 'show' });
  assert.deepEqual(parseMoodCommand('/mood Making 40'), {
    type: 'set',
    accountName: 'Making',
    value: 40,
  });
});

test('parseSetCommand supports false/all/count and rejects invalid values', () => {
  assert.deepEqual(parseSetCommand('/set false'), { type: 'disabled' });
  assert.deepEqual(parseSetCommand('/set all'), { type: 'all' });
  assert.deepEqual(parseSetCommand('/set 250'), { type: 'count', count: 250 });
  assert.deepEqual(parseSetCommand('/set ٣٠'), { type: 'count', count: 30 });
  assert.deepEqual(parseSetCommand('/set 0'), { type: 'invalid' });
  assert.deepEqual(parseSetCommand('/set'), { type: 'invalid' });
  assert.equal(parseSetCommand('/status'), null);
});
