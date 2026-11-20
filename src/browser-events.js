// Runs in the browser through its existing evaluate tool; no extension APIs or UI.
function observe(startedAt) {
  globalThis.__reproEvidence?.dispose();
  const started = Date.parse(startedAt), events = [], controller = new AbortController();
  const names = { Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down' };
  const receive = event => {
    const t = (Date.now() - started) / 1000;
    if (t < 0 || events.length >= 2000) return;
    const entry = { type: event.type, t };
    if (event.type === 'pointerdown') {
      entry.x = event.clientX; entry.y = event.clientY;
    } else if (event.type === 'keydown') {
      if (event.isComposing || event.getModifierState('AltGraph')) return;
      const target = event.composedPath()[0];
      if (target?.getAttribute?.('type')?.toLowerCase() === 'password') return;
      const key = names[event.key] || ((event.ctrlKey || event.metaKey || event.altKey) && event.key.length === 1 ? event.key.toUpperCase() : null);
      if (!key) return;
      entry.keyLabel = [event.ctrlKey && 'Ctrl', event.metaKey && 'Cmd', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
    } else if (event.type === 'scroll' && events.at(-1)?.type === 'scroll' && t - events.at(-1).t < 0.15) return;
    events.push(entry);
  };
  for (const type of ['pointerdown', 'keydown', 'scroll', 'input']) document.addEventListener(type, receive, { capture: true, passive: true, signal: controller.signal });
  globalThis.__reproEvidence = { startedAt, events, dispose: () => controller.abort() };
  return { installed: true, startedAt, viewport: { width: innerWidth, height: innerHeight } };
}

export function browserScript({ startedAt }) {
  return {
    installExpression: `(${observe.toString()})(${JSON.stringify(startedAt)})`,
    readExpression: '({startedAt:globalThis.__reproEvidence.startedAt,events:globalThis.__reproEvidence.events,viewport:{width:innerWidth,height:innerHeight}})',
    cleanupExpression: 'globalThis.__reproEvidence?.dispose(); delete globalThis.__reproEvidence;',
    instruction: 'Evaluate installExpression on your controlled browser tab after native recording starts, using that recording tool\'s startedAt. Read readExpression before stopping or navigating. Pass its events and viewport to capture_export. The observer records only event types, click coordinates, and shortcut/action key labels; it never records field values or ordinary typed text. Only this document is observed; navigation removes it. Evaluate cleanupExpression after reading events. Callout at values use (Date.now() - Date.parse(startedAt)) / 1000 at the moment you inspect their target rectangles.',
  };
}
