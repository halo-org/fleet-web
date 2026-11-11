export function composerAction({
  text,
  hasAttachments,
  canSend,
  canInterrupt,
  interruptPending,
  sending,
}) {
  if (!text.trim() && !hasAttachments && canInterrupt) {
    return {
      type: 'button',
      label: interruptPending ? 'Interrupting…' : 'Interrupt agent',
      icon: 'stop',
      disabled: sending || interruptPending,
      chooseDelivery: false,
    };
  }
  const disabled = sending || !canSend || (!text.trim() && !hasAttachments);
  return {
    type: 'submit',
    label: 'Send message',
    icon: 'arrow-up',
    disabled,
    // Steer and queue only differ while the agent is working.
    chooseDelivery: canInterrupt && !disabled,
  };
}
