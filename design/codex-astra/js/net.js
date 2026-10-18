// SSE client. EventSource reconnects by itself; every (re)connect starts with a full snapshot.
export function connect({ mode, session, onSnapshot, onDelta, onStatus }) {
  const q = new URLSearchParams({ mode });
  if (session) q.set('session', session);
  const es = new EventSource(`/events?${q}`);
  const parse = (name, e) => {
    try {
      return JSON.parse(e.data);
    } catch (err) {
      console.error(`[hospital] bad ${name} payload: ${err.message}`);
      return null;
    }
  };
  es.addEventListener('snapshot', (e) => {
    const data = parse('snapshot', e);
    if (data) onSnapshot(data);
  });
  es.addEventListener('delta', (e) => {
    const data = parse('delta', e);
    if (data) onDelta(data);
  });
  es.onopen = () => onStatus('en vivo');
  es.onerror = () => onStatus('reconectando…');
  return es;
}
