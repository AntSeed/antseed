// Notarizes the macOS app bundle after signing.
// Called by electron-builder via the afterSign hook in electron-builder.yml.
//
// Credentials are loaded from apps/desktop/.env:
//   APPLE_ID              - Your Apple ID email (e.g. santwarg1@icloud.com)
//   APPLE_APP_PASSWORD    - App-specific password from appleid.apple.com
//   APPLE_TEAM_ID         - Your Team ID (H3M5BXXQR2)

import { notarize } from '@electron/notarize';
import { config } from 'dotenv';
import path from 'node:path';

config(); // loads .env from CWD (apps/desktop/)

export default async function notarizing(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID } = process.env;

  if (!APPLE_ID || !APPLE_APP_PASSWORD || !APPLE_TEAM_ID) {
    console.warn('[notarize] Skipping notarization: APPLE_ID, APPLE_APP_PASSWORD, or APPLE_TEAM_ID not set.');
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log(`[notarize] Submitting ${appPath} to Apple notary service...`);
  console.log(`[notarize] This typically takes 1-5 minutes.`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] Notarization complete.');
}
