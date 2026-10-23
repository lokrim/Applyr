export const branding = {
  name: 'applyr',
  description: 'Local-first application assistance. Review and submit yourself.',
  tagline: 'Your next application, with you in control.',
  firefoxId: 'applyr@local.invalid',
  pages: { popup: '/popup.html', session: '/session.html', options: '/options.html' },
  copy: {
    setup: 'Set up your first candidate profile',
    foundation: 'The extension foundation is ready. Profile setup arrives in the next implementation step.',
    privacy: 'This checkpoint contains only a source-tab reference and setup state. It expires after seven days. Local storage is not an encrypted vault.',
    manual: 'You review every application and submit on the employer’s page yourself.',
  },
} as const;
