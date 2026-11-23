(() => {
  if (globalThis.__reproInstalled?.active) return;
  const listeners = new AbortController();
  const state = { active: true, dispose: () => { state.active = false; listeners.abort(); observer.disconnect(); } };
  globalThis.__reproInstalled = state;
  const observed = new WeakSet();
  const fields = new WeakMap();
  let nextField = 0;
  const send = async event => {
    if (!state.active) return;
    try { await chrome.runtime.sendMessage({ destination: 'background', type: 'event', event }); }
    catch (error) {
      if (/Extension context invalidated/.test(error.message)) { state.dispose(); return; }
      if (!/Receiving end does not exist/.test(error.message)) throw error;
    }
  };
  function keyboardLabel(event) {
    if (event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return undefined;
    const names = { Enter: 'Enter', Tab: 'Tab', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', Insert: 'Insert' };
    let key = names[event.key];
    if (!key && /^F(?:[1-9]|1[0-2])$/.test(event.key)) key = event.key;
    if (!key && ((event.ctrlKey || event.metaKey) && /^[!-~]$/.test(event.key) || event.altKey && /^[a-z0-9]$/i.test(event.key))) key = event.key.toUpperCase();
    const target = event.composedPath?.()[0] || event.target;
    const editable = target?.isContentEditable || target?.closest?.('input,textarea,[contenteditable="true"]');
    if (event.key === ' ' && (!editable || event.ctrlKey || event.metaKey)) key = 'Space';
    if (!key) return undefined;
    return [event.ctrlKey && 'Ctrl', event.metaKey && 'Cmd', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
  }
  function documents(doc = document, offset = { x: 0, y: 0 }) {
    const result = [{ doc, offset }];
    for (const frame of doc.querySelectorAll('iframe')) {
      if (frame.contentDocument) {
        const rect = frame.getBoundingClientRect();
        result.push(...documents(frame.contentDocument, { x: offset.x + rect.x + frame.clientLeft, y: offset.y + rect.y + frame.clientTop }));
      }
    }
    return result;
  }
  function viewportRect(element, offset) {
    const rect = element?.getBoundingClientRect?.();
    if (rect?.width && rect.height) return { x: rect.x + offset.x, y: rect.y + offset.y, width: rect.width, height: rect.height };
  }
  function fieldDetail(element, offset) {
    const field = element?.closest?.('input,textarea,[contenteditable=""],[contenteditable="true"]');
    if (!field || field.tagName === 'INPUT' && !['text', 'search', 'email', 'url', 'tel', 'number', ''].includes(field.type)) return undefined;
    const rect = viewportRect(field, offset);
    if (!rect) return undefined;
    if (!fields.has(field)) fields.set(field, ++nextField);
    return { id: fields.get(field), rect };
  }
  function observe() {
    for (const { doc } of documents()) {
      if (observed.has(doc)) continue;
      observed.add(doc);
      let lastPointerMove = 0;
      for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'keydown', 'scroll', 'focusin', 'beforeinput', 'paste', 'input']) doc.addEventListener(type, event => {
        if (type === 'click' && event.detail !== 0) return;
        if (type === 'pointermove' && Date.now() - lastPointerMove < 33) return;
        if (type === 'pointermove') lastPointerMove = Date.now();
        const offset = documents().find(entry => entry.doc === doc)?.offset || { x: 0, y: 0 };
        const rect = event.target?.getBoundingClientRect?.();
        const element = event.composedPath?.()[0] || event.target;
        const field = fieldDetail(element, offset);
        const targetRect = ['pointerdown', 'click'].includes(type) ? viewportRect(element?.closest?.('button,a[href],input,textarea,select,label,summary,[role=button],[role=menuitem],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch]') || element, offset) : undefined;
        const keyLabel = type === 'keydown' ? keyboardLabel(event) : undefined;
        send({ type, ...(['pointermove', 'pointerdown', 'pointerup'].includes(type) ? { buttons: event.buttons } : {}), ...(field ? { field } : {}), ...(targetRect ? { targetRect } : {}), ...(keyLabel ? { keyLabel } : {}), at: Date.now(), x: type === 'click' ? (rect?.x || 0) + (rect?.width || 0) / 2 + offset.x : (event.clientX || 0) + offset.x, y: type === 'click' ? (rect?.y || 0) + (rect?.height || 0) / 2 + offset.y : (event.clientY || 0) + offset.y });
        if (type === 'input' && field) requestAnimationFrame(() => {
          const updated = fieldDetail(element, documents().find(entry => entry.doc === doc)?.offset || offset);
          if (updated) send({ type: 'editlayout', field: updated, at: Date.now() });
        });
      }, { capture: true, passive: true, signal: listeners.signal });
    }
  }
  observe();
  const observer = new MutationObserver(observe);
  observer.observe(document, { subtree: true, childList: true });
  addEventListener('load', observe, { capture: true, signal: listeners.signal });
  addEventListener('resize', () => send({ type: 'viewportResize', at: Date.now(), viewport: { width: innerWidth, height: innerHeight } }), { signal: listeners.signal });
  function roots(doc) {
    const result = [doc];
    for (const element of doc.querySelectorAll('*')) if (element.shadowRoot) result.push(...roots(element.shadowRoot));
    return result;
  }
  function accessibleName(element) {
    const labels = element.getAttribute('aria-labelledby');
    if (labels) return labels.split(/\s+/).map(id => element.ownerDocument.getElementById(id)?.textContent || '').join(' ').trim();
    return (element.getAttribute('aria-label') || Array.from(element.labels || []).map(label => label.textContent).join(' ') || element.innerText || element.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
  }
  function role(element) {
    return element.getAttribute('role') || ({ BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', A: 'link', DIALOG: 'dialog', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' }[element.tagName]) || (element.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button' }[element.type] || 'textbox') : '');
  }
  function resolve(target) {
    if ('x' in target) return target;
    const matches = [];
    for (const { doc, offset } of documents()) for (const root of roots(doc)) {
      let elements;
      if (target.text) elements = [...root.querySelectorAll('*')].filter(element => (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ') === target.text && ![...element.children].some(child => (child.innerText || child.textContent || '').trim().replace(/\s+/g, ' ') === target.text));
      else if (target.selector) elements = [...root.querySelectorAll(target.selector)];
      else if (target.testId) elements = [...root.querySelectorAll(`[data-testid="${CSS.escape(target.testId)}"]`)];
      else elements = [...root.querySelectorAll('*')].filter(element => role(element) === target.role && accessibleName(element) === target.name);
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.width && rect.height && getComputedStyle(element).visibility !== 'hidden') matches.push({ x: rect.x + offset.x, y: rect.y + offset.y, width: rect.width, height: rect.height });
      }
    }
    if (matches.length !== 1) throw new Error(`Target resolved to ${matches.length} visible elements; use a unique testId or selector.`);
    const match = matches[0];
    if (match.x + match.width <= 0 || match.y + match.height <= 0 || match.x >= innerWidth || match.y >= innerHeight) throw new Error('Target is outside the viewport. Scroll it into view using your Chrome tools first.');
    return match;
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!state.active || message.type !== 'resolve') return;
    try {
      const options = message.options;
      const targets = options.region ? (Array.isArray(options.region) ? options.region : [options.region]).map(resolve) : [{ x: 0, y: 0, width: innerWidth, height: innerHeight }];
      const padding = options.region ? options.padding : 0;
      const x = Math.max(0, Math.floor(Math.min(...targets.map(t => t.x)) - padding));
      const y = Math.max(0, Math.floor(Math.min(...targets.map(t => t.y)) - padding));
      const right = Math.min(innerWidth, Math.ceil(Math.max(...targets.map(t => t.x + t.width)) + padding));
      const bottom = Math.min(innerHeight, Math.ceil(Math.max(...targets.map(t => t.y + t.height)) + padding));
      if (right <= x || bottom <= y) throw new Error('Crop does not intersect the viewport.');
      respond({ region: { x, y, width: right - x, height: bottom - y }, viewport: { width: innerWidth, height: innerHeight }, highlights: (options.highlight || []).map(h => ({ ...h, rect: resolve(h.target) })), url: location.href });
    } catch (error) { respond({ error: error.message }); }
  });
})();
