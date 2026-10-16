import managers from '../league/managers.json';
export interface LeagueManager {
  name: string;
  commissioner: boolean;
}
export const leagueManagers: LeagueManager[] = managers;
function validManager(value: unknown): value is LeagueManager {
  if (!value || typeof value !== 'object') return false;
  const manager = value as Record<string, unknown>;
  return typeof manager.name === 'string' && manager.name.trim().length > 0
    && manager.name.length <= 100 && typeof manager.commissioner === 'boolean';
}
export function validateManagers(value: unknown): LeagueManager[] {
  if (!Array.isArray(value) || value.length !== 10 || !value.every(validManager)) {
    throw new Error('Provide exactly ten valid manager names and commissioner flags');
  }
  const entries = value.map(manager => ({ ...manager, name: manager.name.trim() }));
  const distinctNames = new Set(entries.map(manager => manager.name));
  const commissionerCount = entries.filter(manager => manager.commissioner).length;
  if (distinctNames.size !== 10 || commissionerCount !== 1) {
    throw new Error('Provide ten distinct names and exactly one commissioner');
  }
  return entries;
}
