import { localBackend } from './local-backend';
import { api } from '../convex/_generated/api';
async function main() {
    const backend = await localBackend('smoke');
    try {
        console.log(JSON.stringify(backend.identity));
        console.log(await backend.admin('admin:managers'));
        const result = await backend.client.mutation(api.auction.claimSeat, { managerId: 1 });
        if (!result.ok) throw new Error(result.error);
        if (result.value.length !== 64) throw new Error('Invalid seat token length');
        console.log({ claimed: true, identified: (await backend.client.query(api.auction.state,
            { token: result.value })).me === 1 });
    } finally {
        await backend.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
