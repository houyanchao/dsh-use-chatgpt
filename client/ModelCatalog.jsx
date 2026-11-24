import { useEffect, useId, useRef, useState } from 'react';
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { PanelIcon } from './PanelIcon.jsx';
import styles from './model-catalog.css';

const copy = {
  zh: {
    title: '可用模型', hint: '开启的模型会显示在对话的「ChatGPT 套餐」列表中。',
    count: (enabled, total) => `已开启 ${enabled}/${total}`,
    inputs: '输入类型', effort: '推理等级', id: '模型 ID', standard: '模型默认',
    toggle: name => `在模型选择器中显示 ${name}`, failed: '无法更改此模型的显示状态，请重试。',
    modalities: { text: '文本', image: '图片' },
    levels: { none: '关闭', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大' },
  },
  en: {
    title: 'Available models', hint: 'Enabled models appear under ChatGPT Plan in the model picker.',
    count: (enabled, total) => `${enabled} of ${total} enabled`,
    inputs: 'Input types', effort: 'Reasoning effort', id: 'Model ID', standard: 'Model default',
    toggle: name => `Show ${name} in the model picker`, failed: 'Could not change this model’s visibility. Try again.',
    modalities: { text: 'Text', image: 'Images' },
  },
};

function ModelRow({ model, words, joiner, disabled, status, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const enabled = model.enabled !== false;
  const inputs = model.inputModalities?.map(key => words.modalities[key] ?? key).join(joiner);
  const levels = model.reasoning?.efforts?.map(level => words.levels?.[level.id] ?? level.name ?? level.id).join(joiner);
  return <li className="cg-model-row" data-enabled={enabled}>
    <button type="button" className="cg-model-disclosure" aria-expanded={expanded} aria-controls={detailsId}
      onClick={() => setExpanded(!expanded)}>
      <span>{model.name}</span>
      <PanelIcon name="down" size={13} />
    </button>
    <div className="cg-model-switch" aria-busy={status === 'saving'}>
      <Switch checked={enabled} label={words.toggle(model.name)} disabled={disabled || status === 'saving'}
        onChange={value => onChange(model.id, value)} />
    </div>
    <dl id={detailsId} className="cg-model-facts" hidden={!expanded}>
      {inputs && <div><dt>{words.inputs}</dt><dd>{inputs}</dd></div>}
      <div><dt>{words.effort}</dt><dd>{levels || words.standard}</dd></div>
      <div><dt>{words.id}</dt><dd><code>{model.id}</code></dd></div>
    </dl>
    {status === 'error' && <p role="alert" className="dsh-use-chatgpt-error">{words.failed}</p>}
  </li>;
}

export function ModelCatalog({ t, language, resource, profileId }) {
  const heading = useId();
  const words = copy[language] ?? copy.zh;
  const { data: models, error, refresh, refreshing, update } = resource;
  const writes = useRef(new Map());
  const [status, setStatus] = useState(new Map());
  useEffect(() => {
    const active = writes.current;
    setStatus(new Map());
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, [profileId]);

  function setRowStatus(id, value) {
    setStatus(previous => {
      const next = new Map(previous);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });
  }

  async function changeVisibility(model, enabled) {
    if (!profileId || refreshing || writes.current.has(model)) return;
    const controller = new AbortController();
    const { signal } = controller;
    writes.current.set(model, controller);
    setRowStatus(model, 'saving');
    try {
      const response = await fetch('/api/dsh-use-chatgpt/model-visibility', {
        method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ profileId, model, enabled }),
      });
      if (!response.ok) throw new Error();
      const saved = await response.json();
      if (saved.model !== model || saved.enabled !== enabled) throw new Error();
      if (signal.aborted) return;
      update(current => current?.map(row => row.id === model ? { ...row, enabled: saved.enabled } : row));
      setRowStatus(model, null);
    } catch {
      if (!signal.aborted) setRowStatus(model, 'error');
    } finally {
      if (writes.current.get(model) === controller) writes.current.delete(model);
    }
  }

  return <section className="cg-catalog" aria-labelledby={heading}>
    <style>{styles}</style>
    <header className="cg-catalog-header">
      <h2 id={heading}>{words.title}</h2>
      {models?.length > 0 && <span className="cg-model-count">{words.count(models.filter(model => model.enabled !== false).length, models.length)}</span>}
      <button type="button" className="cg-catalog-refresh" onClick={refresh} disabled={refreshing || Array.from(status.values()).includes('saving')}
        aria-busy={refreshing} aria-label={t('refreshModels')} title={t('refreshModels')}>
        <PanelIcon name="refresh" size={16} />
      </button>
    </header>
    <p className="cg-catalog-hint">{words.hint}</p>
    {error !== null && <p role="alert" className="dsh-use-chatgpt-error">{error || t('modelsFailed')}</p>}
    {error === null && !models?.length && <p role="status">{t(models ? 'modelsEmpty' : 'modelsLoading')}</p>}
    {models?.length > 0 && <ul className="cg-model-list" aria-labelledby={heading}>
      {models.map(model => <ModelRow key={model.id} model={model} words={words} joiner={language === 'en' ? ', ' : '、'}
        disabled={!profileId || refreshing} status={status.get(model.id)} onChange={changeVisibility} />)}
    </ul>}
  </section>;
}
