import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { importFixture } from './import-fixture.ts';
import { sourceUrls } from '../lib/import-data.ts';

const now = Number(process.env.IMPORT_TEST_NOW || Date.now());
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
};
const write = fs.writeFile.bind(fs);
fs.writeFile = async (...args) => {
    await write(...args);
    await fs.utimes(args[0], now / 1000, now / 1000);
};
syncBuiltinESMExports();
const raw = process.env.IMPORT_TEST_FIXTURE
    ? JSON.parse(readFileSync(process.env.IMPORT_TEST_FIXTURE, 'utf8')) : importFixture();
globalThis.fetch = async url => {
    const index = sourceUrls.indexOf(String(url));
    if (index < 0) throw new Error('Network access is forbidden in import tests');
    if (process.env.IMPORT_TEST_FETCH_LOG) {
        await fs.appendFile(process.env.IMPORT_TEST_FETCH_LOG, `${JSON.stringify({ index, now })}\n`);
    }
    return new Response(JSON.stringify(raw[index]), { status: 200 });
};
