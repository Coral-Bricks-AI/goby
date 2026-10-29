export const REVIEW_VERSION = '0.3.0';
export const STATUS_CONTEXT = 'Goby Review';
export const GATE_CONTEXT = 'Goby Gate';
export const MARKER = 'goby';
export const SUMMARY_PREFIX = `**${STATUS_CONTEXT}**`;
export function botLogins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.GOBY_BOT_LOGINS ?? 'github-actions,github-actions[bot]').split(',').map(s => s.trim()).filter(Boolean);
}
export const BOT_LOGINS = botLogins();
