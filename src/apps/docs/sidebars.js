// Share the reading order across usage and implementation without copying content.
const groups = [
  ['Compose an application', ['app', 'configuration', 'di', 'definitions', 'actions', 'middleware', 'errors']],
  ['Expose operations', ['controllers', 'http', 'cli', 'client', 'studio']],
  ['Store and coordinate data', ['database', 'pagination', 'cache', 'lock', 'throttling']],
  ['Authenticate and integrate', ['authentication', 'authorization', 'tokens', 'email', 'outbound_http']],
  ['Run background work', ['workers', 'scheduled_tasks', 'workflows', 'background', 'events', 'concurrency', 'scheduling']],
  ['Observe and test', ['logging', 'observability', 'testing', 'utilities']],
];
const categories = (section) => groups.map(([label, names]) => ({
  type: 'category', label, items: names.map((name) => `${section}/${name}`),
}));

export default {
  guides: ['README', 'usage/README', 'usage/installation', ...categories('usage')],
  advanced: [
    'contributing', 'implementation/README', 'implementation/distribution',
    ...categories('implementation'),
    { type: 'category', label: 'Design records and future work', items: [
      'stack', 'workers_specs', 'workflows_specs', 'native_logging_plan', 'monitoring', 'beacon',
    ].map((name) => `implementation/${name}`) },
  ],
};
