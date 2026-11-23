import { useSyncExternalStore } from 'react';
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import { useChatOptions } from './use-chat-options.js';

function SearchRetry({ t, message, retry }) {
  return <button type="button" className="cg-search-retry" title={message} onClick={retry}>
    {t('searchRetry')}<span className="cg-search-sr" role="alert">{message}</span>
  </button>;
}

function SessionSearch({ profileId, id, t }) {
  const { features, saving, save, error, retry } = useChatOptions(profileId, id);
  if (!features) return error ? <SearchRetry t={t} message={error} retry={retry} /> : null;
  return <div className="cg-search-tool" aria-busy={Boolean(saving)}>
    <label title={t('searchHelp')} className="cg-search-label">
      <span>{t('webSearch')}</span>
      <Switch checked={features.webSearch} label={t('webSearch')} title={t('searchHelp')}
        onChange={webSearch => { void save({ webSearch }); }} />
    </label>
    {error && <span role="alert" className="cg-search-failure" title={error}>{t('saveFailed')}</span>}
  </div>;
}

function ConnectedSearch({ id, t, useConnection }) {
  const { connection, error, refresh } = useConnection();
  if (error) return <SearchRetry t={t} message={t('requestFailed')} retry={() => { void refresh(); }} />;
  if (connection?.status !== 'connected' || !connection.sharing || !connection.profileId) return null;
  return <SessionSearch key={JSON.stringify([id, connection.profileId])} id={id} profileId={connection.profileId} t={t} />;
}

function ModelSearch({ directory, id, t, useConnection }) {
  const model = useSyncExternalStore(directory.subscribe, directory.getSnapshot);
  if (model.current?.provider !== 'chatgpt-plan' || model.routable === false) return null;
  return <ConnectedSearch id={id} t={t} useConnection={useConnection} />;
}

export function registerNativeChatOptions(ctx, useConnection) {
  ctx.inject(['slots', 'sessions', 'modelDirectories'], scope => {
    scope.slots.inject('conversation.input.left', () => scope.slots.register({
      name: 'conversation.input.left', id: 'dsh-use-chatgpt', order: 0, locale: 'dsh-use-chatgpt',
      inject: id => {
        if (scope.sessions.subagentAddress(id) !== undefined) return {};
        return { id, directory: scope.modelDirectories.directoryFor(id).store };
      },
    }, function NativeSearch({ id, directory, t }) {
      return directory ? <ModelSearch id={id} directory={directory} t={t} useConnection={useConnection} /> : null;
    }));
  });
}
