import type { NextConfig } from 'next';
import { sourceVersion } from './lib/app-version';

// Inlined into the client and /version.json; an open app compares the two to find a newer deployment.
const version = process.env.PANCAKE_APP_VERSION || sourceVersion(process.cwd());
// The development badge would sit on the bottom tab bar.
const config: NextConfig = { poweredByHeader: false, distDir: process.env.NEXT_DIST_DIR || '.next', env: { APP_VERSION: version },
  devIndicators: false };
export default config;
