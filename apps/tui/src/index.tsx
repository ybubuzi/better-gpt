import { render } from 'ink';
import type { TuiApplication } from './application.js';
import { Dashboard } from './dashboard.js';

export async function runTui(application: TuiApplication): Promise<void> {
  const instance = render(<Dashboard application={application} />, {
    exitOnCtrlC: false, alternateScreen: true, maxFps: 20,
  });
  try { await instance.waitUntilExit(); }
  finally { await application.dispose(); }
}
