import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextText, formatHistoryLines } from '../src/ai/promptBuilder.js';

test('buildContextText adds time gap markers for separated messages', () => {
  const context = buildContextText([
    {
      role: 'user',
      source: 'human',
      author: 'Making',
      text: 'first',
      timestamp: '2026-02-16T10:00:00.000Z',
    },
    {
      role: 'user',
      source: 'human',
      author: 'Making',
      text: 'second',
      timestamp: '2026-02-16T11:10:00.000Z',
    },
  ]);
  assert.match(context, /\[time_gap\]/);
  assert.match(context, /1h 10m later/);
});

test('formatHistoryLines adds new day marker', () => {
  const lines = formatHistoryLines([
    {
      author: 'Making',
      text: 'day one',
      timestamp: '2026-02-16T10:00:00.000Z',
    },
    {
      author: 'Making',
      text: 'day two',
      timestamp: '2026-02-17T12:00:00.000Z',
    },
  ]);
  const joined = lines.join('\n');
  assert.match(joined, /\[time_gap\]/);
  assert.match(joined, /new day/);
});
