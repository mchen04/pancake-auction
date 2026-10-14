import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { selectDirectDatabase } from '../lib/db';

export function loadEnvironment() {
  const path = process.env.PANCAKE_AUCTION_ENV_FILE || '/Users/michaelchen/.config/pancake-auction/.env';
  let values: Record<string, string | undefined>;
  try {
    values = parseEnv(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Database access is missing. Configure the authorized environment file.');
  }
  if (!values.DATABASE_URL || !values.DATABASE_URL_POOLED) {
    throw new Error('Database access is missing. Configure the authorized environment file.');
  }
  process.env.DATABASE_URL = values.DATABASE_URL;
  process.env.DATABASE_URL_POOLED = values.DATABASE_URL_POOLED;
  selectDirectDatabase();
}
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database URL redacted]');
}
