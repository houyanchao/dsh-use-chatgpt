const paths = {
  more: 'M5 12h.1M12 12h.1M19 12h.1',
  plus: 'M12 5v14M5 12h14',
  signOut: 'M9 5H5v14h4m5-12 5 5-5 5m-5-5h10',
  down: 'm6 9 6 6 6-6',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  account: 'M15.75 8a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20c.3-4.1 3.1-6.5 7.5-6.5s7.2 2.4 7.5 6.5',
  refresh: 'M20 5v5h-5m4.3-.7A8 8 0 1 0 19 16',
};
export function PanelIcon({ name, size = 18 }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.65} strokeLinecap="round" strokeLinejoin="round">
    <path d={paths[name]} />
  </svg>;
}
