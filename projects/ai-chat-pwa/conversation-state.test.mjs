import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemMessage, moveConversation, sortConversations } from './conversation-state.js';

test('sorts multiple pinned conversations before unpinned conversations', () => {
  const items = [
    { id: 'old', updatedAt: 1 },
    { id: 'pin-a', pinned: true, order: 0, updatedAt: 1 },
    { id: 'pin-b', pinned: true, order: 1, updatedAt: 2 },
    { id: 'new', updatedAt: 3 }
  ];
  assert.deepEqual(sortConversations(items).map(item => item.id), ['pin-a', 'pin-b', 'new', 'old']);
});

test('moves a conversation only within its pinned or unpinned group', () => {
  const items = [
    { id: 'pin', pinned: true, order: 0 },
    { id: 'one', order: 0 },
    { id: 'two', order: 1 }
  ];
  assert.deepEqual(moveConversation(items, 'two', -1).map(item => item.id), ['pin', 'two', 'one']);
  assert.deepEqual(moveConversation(items, 'pin', -1).map(item => item.id), ['pin', 'one', 'two']);
});

test('adds room preferences and optional global memory to the system context', () => {
  const withoutGlobal = buildSystemMessage('base', { instructions: 'Ringkas.' }, 'proyek orbit', false);
  assert.match(withoutGlobal.content, /Ringkas/);
  assert.doesNotMatch(withoutGlobal.content, /proyek orbit/);
  const withGlobal = buildSystemMessage('base', {}, 'proyek orbit', true);
  assert.match(withGlobal.content, /proyek orbit/);
});
