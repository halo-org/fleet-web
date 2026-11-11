import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerAction } from '../public/composer.js';

const action = (options = {}) =>
  composerAction({
    text: '',
    hasAttachments: false,
    canSend: true,
    canInterrupt: false,
    interruptPending: false,
    sending: false,
    ...options,
  });

test('an empty composer interrupts only while work is interruptible', () => {
  assert.deepEqual(action(), {
    type: 'submit', label: 'Send message', icon: 'arrow-up', disabled: true, chooseDelivery: false,
  });
  assert.deepEqual(action({ canInterrupt: true }), {
    type: 'button', label: 'Interrupt agent', icon: 'stop', disabled: false, chooseDelivery: false,
  });
  assert.equal(action({ canInterrupt: true, text: ' \n ' }).icon, 'stop');
});

test('typing switches interrupt to send and clearing restores interrupt', () => {
  const state = { canInterrupt: true };
  assert.equal(action(state).type, 'button');
  state.text = 'Steer the agent';
  assert.deepEqual(action(state), {
    type: 'submit', label: 'Send message', icon: 'arrow-up', disabled: false, chooseDelivery: true,
  });
  state.text = '';
  assert.equal(action(state).type, 'button');
  state.canInterrupt = false;
  assert.equal(action(state).disabled, true);
});

test('image drafts keep the send action, including while uploading', () => {
  assert.equal(action({ canInterrupt: true, hasAttachments: true }).type, 'submit');
  assert.equal(action({ canInterrupt: true, hasAttachments: true }).disabled, false);
  const uploading = action({ canInterrupt: true, hasAttachments: true, canSend: false });
  assert.equal(uploading.type, 'submit');
  assert.equal(uploading.disabled, true);
});

test('pending interrupts cannot be repeated but do not prevent sending content', () => {
  assert.deepEqual(action({ canInterrupt: true, interruptPending: true }), {
    type: 'button', label: 'Interrupting…', icon: 'stop', disabled: true, chooseDelivery: false,
  });
  const message = action({ canInterrupt: true, interruptPending: true, text: 'Next task' });
  assert.equal(message.type, 'submit');
  assert.equal(message.disabled, false);
});

test('sending disables both actions and unavailable sends stay disabled', () => {
  assert.equal(action({ canInterrupt: true, sending: true }).disabled, true);
  assert.equal(action({ text: 'Task', sending: true }).disabled, true);
  assert.equal(action({ text: 'Task', canSend: false }).disabled, true);
});

test('steer or queue is offered only for a sendable message while work runs', () => {
  assert.equal(action({ text: 'Task' }).chooseDelivery, false);
  assert.equal(action({ text: 'Task', canInterrupt: true }).chooseDelivery, true);
  assert.equal(action({ text: 'Task', canInterrupt: true, sending: true }).chooseDelivery, false);
  assert.equal(action({ text: 'Task', canInterrupt: true, canSend: false }).chooseDelivery, false);
});
