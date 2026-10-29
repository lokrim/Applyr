import { z } from 'zod';

// Run before any runtime schema is constructed. Extension CSP forbids dynamic
// code; Zod's interpreter also avoids its otherwise caught Function probe.
z.config({ jitless: true });
