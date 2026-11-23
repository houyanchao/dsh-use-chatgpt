import { useEffect, useRef, useState } from 'react';

async function readOrSave(profileId, id, signal, patch) {
  const params = new URLSearchParams({ profileId, sessionId: id });
  const response = await fetch('/api/dsh-use-chatgpt/chat-options?' + params, {
    method: patch ? 'POST' : 'GET', cache: 'no-store', signal,
    ...(patch && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
  });
  const data = await response.json();
  if (!response.ok || typeof data?.features?.webSearch !== 'boolean' || typeof data.features.jsonSchema !== 'string') {
    throw new Error(data?.error?.message || '无法读取对话选项，请重试。');
  }
  return data.features;
}

export function useChatOptions(profileId, id) {
  const [state, setState] = useState({ id });
  const [revision, setRevision] = useState(0);
  const generation = useRef(null);
  const writing = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    generation.current = controller;
    writing.current = false;
    setState({ id });
    readOrSave(profileId, id, signal).then(features => {
      if (!signal.aborted) setState({ id, features });
    }).catch(error => { if (!signal.aborted) setState({ id, error: error.message }); });
    return () => controller.abort();
  }, [id, profileId, revision]);

  const current = state.id === id ? state : {};
  async function save(patch) {
    const signal = generation.current?.signal;
    if (!signal || signal.aborted || writing.current || !current.features) return;
    writing.current = true;
    setState({ id, features: current.features, saving: true });
    try {
      const features = await readOrSave(profileId, id, signal, patch);
      if (!signal.aborted) {
        setState({ id, features });
        return { features };
      }
    } catch (error) {
      if (!signal.aborted) setState({ id, features: current.features, error: error.message });
    } finally {
      if (!signal.aborted) writing.current = false;
    }
  }
  return { ...current, save, retry: () => setRevision(value => value + 1) };
}
