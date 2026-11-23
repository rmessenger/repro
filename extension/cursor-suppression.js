(() => {
  if (globalThis.__reproCursorSuppression) return;
  const selector = '[data-testid="browser-agent-cursor"]';
  let current;
  const runtimeId = chrome.runtime.id;
  function snapshot() {
    const host = document.getElementById('codex-agent-overlay-root');
    const root = host && chrome.dom?.openOrClosedShadowRoot?.(host);
    const cursors = root ? [...root.querySelectorAll(selector)] : [];
    return { host, root, cursors };
  }
  function cursorGeometry(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { transform: style.transform, inlineTransform: element.style.transform, opacity: style.opacity, position: style.position, left: style.left, top: style.top, width: style.width, height: style.height, transformOrigin: style.transformOrigin, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }
  function recordPoints(found) {
    if (!current.trackPositions) return;
    if (found.cursors.length !== 1) { current.positionsValid = false; return; }
    const cursor = found.cursors[0], style = getComputedStyle(cursor);
    const match = /^translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0(?:px)?\s*\)/.exec(cursor.style.transform);
    const width = parseFloat(style.width), height = parseFloat(style.height);
    if (!match || width !== 24 || height !== 24 || style.left !== '0px' || style.top !== '0px') { current.positionsValid = false; return; }
    // Codex positions this 24px overlay around the input coordinate, not at its top-left.
    const point = { at: Date.now(), x: Number(match[1]) + width / 2, y: Number(match[2]) + height / 2, opacity: Number(style.opacity) };
    if (![point.x, point.y, point.opacity].every(Number.isFinite)) { current.positionsValid = false; return; }
    const previous = current.points.at(-1);
    if (previous && previous.x === point.x && previous.y === point.y && previous.opacity === point.opacity) return;
    if (current.points.length >= 20000) { current.positionsValid = false; return; }
    current.points.push(point);
  }
  function coverage() {
    if (!current?.captureId || !current.from || !current.through) return;
    return { captureId: current.captureId, from: current.from, through: current.through, points: current.points.slice(current.sentPoints) };
  }
  async function publish() {
    const chunk = coverage();
    if (!chunk) return;
    current.sentPoints = current.points.length;
    current.publishedAt = Date.now();
    try {
      const response = await chrome.runtime.sendMessage({ destination: 'background', type: 'cursorChunk', chunk });
      if (response?.error) throw new Error(response.error);
    } catch (error) {
      if (!/Extension context invalidated|Receiving end does not exist|message port closed/i.test(error.message)) throw error;
    }
  }
  function recordPoses(found) {
    if (!current.probePositions) return;
    const entry = { at: Date.now(), visibility: document.visibilityState, cursors: found.cursors.map(cursorGeometry) };
    const previous = current.poses.at(-1);
    if (previous && JSON.stringify({ ...previous, at: 0 }) === JSON.stringify({ ...entry, at: 0 })) return;
    if (current.poses.length >= 20000) { current.posesTruncated = true; return; }
    current.poses.push(entry);
  }
  function record(reason, found) {
    recordPoses(found);
    const entry = { at: Date.now(), reason, visibility: document.visibilityState, host: Boolean(found.host), cursorCount: found.cursors.length, inlineOpacity: found.cursors.map(e => e.style.opacity), hidden: found.cursors.every(e => getComputedStyle(e).display === 'none') };
    const previous = current.observations.at(-1);
    if (!previous || reason !== previous.reason || JSON.stringify({ ...previous, at: 0 }) !== JSON.stringify({ ...entry, at: 0 })) current.observations.push(entry);
    if (current.observations.length > 200) current.observations.shift();
  }
  function sync(reason) {
    if (!current) return;
    if (runtimeId && chrome.runtime.id !== runtimeId) { cleanup(); return; }
    if (!current.positionsValid || (current.captureId && current.lost && current.supported)) return;
    const found = snapshot();
    if (current.captureId && !current.supported) {
      if (!found.cursors.length) return;
      current.supported = true;
      current.lost = false;
    }
    recordPoints(found);
    if (!current.positionsValid) {
      current.lost ||= current.verified;
      current.verified = false;
      publish();
      stopWatching();
      record('unreadable-position', found);
      return;
    }
    if (!found.root || !found.cursors.length) {
      current.verified = false;
      current.lost = true;
      if (current.captureId) { publish(); stopWatching(); }
      record(reason, found);
      return;
    }
    if (!current.roots.has(found.root)) {
      const style = document.createElement('style');
      style.textContent = `${selector}{display:none!important}`;
      found.root.append(style);
      const observer = new MutationObserver(() => sync('overlay-change'));
      observer.observe(found.root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-testid'] });
      current.roots.set(found.root, { style, observer });
    }
    const installed = current.roots.get(found.root);
    if (installed.style.parentNode !== found.root) {
      current.lost = true;
      found.root.append(installed.style);
    }
    current.verified = found.cursors.every(e => getComputedStyle(e).display === 'none');
    if (!current.verified) current.lost = true;
    if (current.captureId) {
      if (current.lost) {
        publish();
        stopWatching();
      } else {
        current.from ??= Date.now();
        current.through = Date.now();
        if (current.through - current.publishedAt >= 250) publish();
      }
    }
    record(reason, found);
  }
  function report() {
    return current ? { requested: true, supported: current.supported, verified: current.verified, safeForAnimation: current.supported && current.verified && !current.lost, lost: current.lost, rootCount: current.roots.size, from: current.from, observations: [...current.observations], ...(current.trackPositions ? { tracking: { source: 'codex-overlay', valid: current.positionsValid, points: [...current.points] } } : {}), ...(current.probePositions ? { poses: [...current.poses], posesTruncated: current.posesTruncated, initialLayout: current.initialLayout } : {}) } : { requested: false, safeForAnimation: false };
  }
  function stopWatching() {
    current.observer?.disconnect();
    clearInterval(current.timer);
    document.removeEventListener('visibilitychange', current.visibilityListener);
    for (const { style, observer } of current.roots.values()) {
      observer.disconnect();
      if (style.parentNode) style.remove();
    }
  }
  function cleanup() {
    if (!current) return;
    stopWatching();
    current = undefined;
  }
  function stop() {
    if (!current) return report();
    try { sync('stop'); return report(); }
    finally { cleanup(); }
  }
  function start(probePositions = false, trackPositions = false, captureId) {
    if (captureId && captureId === current?.captureId) return report();
    stop();
    const found = snapshot();
    const supported = Boolean(found.root && found.cursors.length);
    current = { supported, verified: false, lost: !supported, roots: new Map(), observations: [], probePositions, poses: [], posesTruncated: false, trackPositions, positionsValid: supported || Boolean(captureId), points: [], captureId, sentPoints: 0, publishedAt: 0 };
    if (!supported && !captureId) { record('unsupported', found); return report(); }
    if (probePositions) {
      current.initialLayout = found.cursors.map(cursor => {
        const ancestors = [];
        for (let element = cursor; element; element = element.parentElement) ancestors.push(cursorGeometry(element));
        return { ancestors, host: cursorGeometry(found.host) };
      });
    }
    sync('start');
    if (!current.positionsValid) return report();
    current.observer = new MutationObserver(() => sync('document-change'));
    current.observer.observe(document.documentElement, { childList: true, subtree: true });
    current.visibilityListener = () => sync('visibility-change');
    document.addEventListener('visibilitychange', current.visibilityListener);
    current.timer = setInterval(() => sync('check'), probePositions || trackPositions ? 33 : 250);
    return report();
  }
  globalThis.__reproCursorSuppression = { start, stop, report };
  addEventListener('pagehide', () => {
    if (current?.captureId) publish();
    cleanup();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== 'cursorControl') return;
    try {
      if (message.operation === 'start') respond(start(message.probePositions === true, message.trackPositions === true, message.captureId));
      else if (message.operation === 'stop') {
        if (message.captureId && current?.captureId !== message.captureId) { respond({ requested: false, safeForAnimation: false }); return; }
        sync('status');
        const chunk = coverage();
        respond({ ...stop(), chunk });
      }
      else { sync('status'); respond(report()); }
    } catch (error) { respond({ error: error.message }); }
  });
})();
