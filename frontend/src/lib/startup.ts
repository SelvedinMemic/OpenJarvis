import { isTauri } from './api';

const STARTUP_ASSISTANT_KEY = 'openjarvis-startup-assistant';
const LAUNCH_AT_LOGIN_KEY = 'openjarvis-launch-at-login';

export const STARTUP_ACTIONS = [
  {
    id: 'emails',
    label: 'E-Mails zusammenfassen',
    prompt: 'Bitte fasse meine wichtigsten E-Mails von heute zusammen.',
  },
  {
    id: 'news',
    label: 'Heutige Nachrichten',
    prompt: 'Bitte gib mir eine kurze Zusammenfassung der wichtigsten heutigen Nachrichten.',
  },
  {
    id: 'calendar',
    label: 'Mit Kalender starten',
    prompt: 'Bitte starte mit meinen heutigen Kalenderaufgaben und priorisiere die wichtigsten Punkte.',
  },
] as const;

export const STARTUP_FOLLOWUP =
  'Was moechtest du als Naechstes? Soll ich 1) E-Mails zusammenfassen, 2) heutige Nachrichten zusammenfassen oder 3) mit deinen heutigen Kalenderaufgaben starten?';

export function startupAssistantEnabled(): boolean {
  if (!isTauri()) return false;
  return localStorage.getItem(STARTUP_ASSISTANT_KEY) !== 'false';
}

export function setStartupAssistantEnabled(enabled: boolean): void {
  localStorage.setItem(STARTUP_ASSISTANT_KEY, String(enabled));
}

export function normalizeStartupCommand(raw: string): string {
  const input = raw.trim();
  const lowered = input.toLowerCase();

  if (
    lowered === '1' ||
    lowered === 'email' ||
    lowered === 'e-mail' ||
    lowered === 'emails' ||
    lowered === 'e-mails' ||
    lowered.includes('mail')
  ) {
    return STARTUP_ACTIONS[0].prompt;
  }

  if (
    lowered === '2' ||
    lowered === 'news' ||
    lowered.includes('nachricht') ||
    lowered.includes('heutige nachrichten')
  ) {
    return STARTUP_ACTIONS[1].prompt;
  }

  if (
    lowered === '3' ||
    lowered.includes('kalender') ||
    lowered.includes('calendar') ||
    lowered.includes('aufgaben')
  ) {
    return STARTUP_ACTIONS[2].prompt;
  }

  return input;
}

async function loadAutostartApi() {
  if (!isTauri()) return null;
  try {
    return await import('@tauri-apps/plugin-autostart');
  } catch {
    return null;
  }
}

export async function getLaunchAtLoginEnabled(): Promise<boolean | null> {
  if (!isTauri()) return null;

  const plugin = await loadAutostartApi();
  if (!plugin) return null;

  try {
    return await plugin.isEnabled();
  } catch {
    return null;
  }
}

export async function setLaunchAtLoginEnabled(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return false;

  const plugin = await loadAutostartApi();
  if (!plugin) return false;

  try {
    if (enabled) {
      await plugin.enable();
    } else {
      await plugin.disable();
    }
    localStorage.setItem(LAUNCH_AT_LOGIN_KEY, String(enabled));
    return true;
  } catch {
    return false;
  }
}

export async function ensureAutostartPreferenceApplied(): Promise<void> {
  if (!isTauri()) return;

  const saved = localStorage.getItem(LAUNCH_AT_LOGIN_KEY);
  if (saved == null) {
    // Default: enable launch-at-login on first desktop run.
    await setLaunchAtLoginEnabled(true);
    return;
  }

  await setLaunchAtLoginEnabled(saved !== 'false');
}
