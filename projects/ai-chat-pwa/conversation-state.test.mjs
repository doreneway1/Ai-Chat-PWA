import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemMessage,
  moveConversation,
  normalizeConversationOrders,
  sortConversations
} from './conversation-state.js';

test('keeps pinned conversations above unpinned and respects manual order', () => {
  const conversations = [
    { id: 'older', updatedAt: 1 },
    { id: 'pin-a', pinned: true, order: 0 },
    { id: 'pin-b', pinned: true, order: 1 },
    { id: 'newer', updatedAt: 3 }
  ];
  assert.deepEqual(sortConversations(conversations).map(item => item.id), [
    'pin-a', 'pin-b', 'newer', 'older'
  ]);
});

test('moves a conversation only within its pinned group without mutating input', () => {
  const conversations = [
    { id: 'pin', pinned: true, order: 0 },
    { id: 'first', order: 0 },
    { id: 'second', order: 1 }
  ];
  const moved = moveConversation(conversations, 'second', -1);
  assert.deepEqual(moved.map(item => item.id), ['pin', 'second', 'first']);
  assert.deepEqual(conversations.map(item => item.id), ['pin', 'first', 'second']);
});

test('normalizes missing order fields while preserving the previous display order', () => {
  const conversations = [
    { id: 'old', updatedAt: 1 },
    { id: 'new', updatedAt: 2 },
    { id: 'pinned', pinned: true, updatedAt: 0 }
  ];
  const normalized = normalizeConversationOrders(conversations);
  assert.deepEqual(normalized.map(item => [item.id, item.order]), [
    ['pinned', 0],
    ['new', undefined],
    ['old', undefined]
  ]);
  assert.deepEqual(
    sortConversations(normalized).filter(item => !item.pinned).map(item => item.id),
    ['new', 'old']
  );
  assert.equal(Object.hasOwn(conversations[0], 'order'), false);
});

test('keeps unpinned chats sorted by recent activity until the user reorders them', () => {
  const conversations = [
    { id: 'older', updatedAt: 1 },
    { id: 'newer', updatedAt: 2 }
  ];
  assert.deepEqual(sortConversations(conversations).map(item => item.id), ['newer', 'older']);
  const moved = moveConversation(conversations, 'older', -1);
  assert.deepEqual(moved.map(item => item.id), ['older', 'newer']);
  assert.ok(moved.every(item => item.manualOrder));
});

test('includes manual global memory only when the room opted in', () => {
  const withoutMemory = buildSystemMessage('base', {}, 'prefer Indonesian', false);
  const withMemory = buildSystemMessage('base', {}, 'prefer Indonesian', true);
  assert.doesNotMatch(withoutMemory.content, /prefer Indonesian/);
  assert.match(withMemory.content, /prefer Indonesian/);
});

test('adds room instructions without treating them as policy overrides', () => {
  const system = buildSystemMessage('base', { instructions: 'Jawab ringkas.' }, '', false);
  assert.match(system.content, /Jawab ringkas/);
  assert.match(system.content, /tidak menggantikan kebijakan keselamatan/);
});
