export const branding = {
  name: 'applyr',
  description: 'Local-first application assistance. Review and submit yourself.',
  tagline: 'Your next application, with you in control.',
  firefoxId: 'applyr@local.invalid',
  pages: { popup: '/popup.html', session: '/session.html', options: '/options.html' },
  copy: {
    setup: 'Set up your first candidate profile',
    foundation: 'Create or import a candidate profile locally, review it, then choose a saved default or a whole profile for this session.',
    privacy: 'This checkpoint keeps the bound tab, sanitized application metadata and local setup state for seven days. Local storage is not an encrypted vault.',
    manual: 'You review every application and submit on the employer’s page yourself.',
  },
} as const;
