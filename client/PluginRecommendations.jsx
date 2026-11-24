import { useId, useSyncExternalStore } from 'react';

const plugins = [
  { title: 'dsh-open-model', packageName: 'dsh-open-model', description: 'freeModelsDescription',
    guide: 'https://github.com/houyanchao/dsh-open-model#在自研-dsh-客户端安装' },
  { title: 'dsh-timeline', packageName: 'dsh-timeline', description: 'timelineDescription',
    guide: 'https://github.com/houyanchao/dsh-timeline#-安装' },
  { title: 'timeline', description: 'browserDescription', stores: [
    { label: 'chromeStore', href: 'https://chromewebstore.google.com/detail/fgebdnlceacaiaeikopldglhffljjlhh' },
    { label: 'edgeStore', href: 'https://microsoftedge.microsoft.com/addons/detail/ekednjjojnhlajfobalaaihkibbdcbab' },
  ] },
];

function InstallButton({ plugin, installer, state, t }) {
  const { packageName, title } = plugin;
  let label = 'installPlugin';
  if (state.pending === packageName) label = 'installingPlugin';
  else if (state.inventory === 'unavailable') label = 'installUnavailable';
  else if (state.inventory === 'failed') label = 'retryPlugins';
  else if (state.inventory === 'loading') label = 'checkingPlugins';
  else if (state.installed.has(packageName)) label = 'installedPlugin';
  return <button type="button" className="cg-plugin-action" data-state={label}
    aria-label={t('pluginAction', { name: title, action: t(label) })}
    disabled={Boolean(state.pending) || (label !== 'installPlugin' && label !== 'retryPlugins')}
    onClick={() => { void (label === 'retryPlugins' ? installer.refresh() : installer.install(packageName)); }}>
    {t(label)}
  </button>;
}

export function PluginRecommendations({ installer, t }) {
  const headingId = useId();
  const state = useSyncExternalStore(installer.subscribe, installer.getSnapshot);
  return <section className="cg-recommendations" aria-labelledby={headingId}>
    <h2 id={headingId}>{t('otherPlugins')}</h2>
    <ul className="cg-plugin-list">{plugins.map(plugin => {
      const { title, packageName, description, stores } = plugin;
      const error = packageName && state.error?.name === packageName && !state.installed.has(packageName) && state.error;
      return <li key={title} className="cg-plugin-row">
        <div><strong>{title}</strong><p>{t(description)}</p></div>
        <div className="cg-plugin-actions" aria-live="polite">
          {stores ? stores.map(({ label, href }) =>
            <a key={label} className="cg-plugin-action" href={href} target="_blank" rel="noopener noreferrer"
              aria-label={t('pluginAction', { name: title, action: t(label) })}>{t(label)}</a>,
          ) : <InstallButton plugin={plugin} installer={installer} state={state} t={t} />}
        </div>
        {error && <p className="dsh-use-chatgpt-error" role="alert">
          {error.problem === 'not-found' ? <>
            {t('packageNotFound', { name: packageName })}{' '}
            <a href={plugin.guide} target="_blank" rel="noopener noreferrer">{t('installGuide')}</a>
          </> : <>{t('installError')} {error.message}</>}
        </p>}
      </li>;
    })}</ul>
    {state.inventory === 'failed' && <p className="dsh-use-chatgpt-error" role="alert">{t('inventoryError')}</p>}
  </section>;
}
