import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRelationshipDelta } from '../src/memory/relationships.js';

test('scoreRelationshipDelta rewards positive language', () => {
  const delta = scoreRelationshipDelta('تسلم يا نوفا انت جامد جدا');
  assert.ok(delta.affinityDelta > 0);
  assert.ok(delta.trustDelta >= 0);
});

test('scoreRelationshipDelta penalizes harsh negative language', () => {
  const delta = scoreRelationshipDelta('اسكت يا نوفا انت رخم جدا', { addressedToBot: true });
  assert.ok(delta.affinityDelta < 0);
  assert.ok(delta.trustDelta < 0);
});

