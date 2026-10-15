import { describe, expect, it } from 'vitest';
import { localPorts } from '../scripts/local-ports';

describe('Local backend ports', () => {
    it('defaults to stable ports without binding them', () => {
        expect(localPorts({})).toEqual({ cloud: 3210, site: 3211 });
    });
    it('uses separate configured ports', () => {
        expect(localPorts({ CONVEX_LOCAL_CLOUD_PORT: '43000', CONVEX_LOCAL_SITE_PORT: '43001' }))
            .toEqual({ cloud: 43000, site: 43001 });
    });
    it('rejects invalid and equal ports before starting a process', () => {
        for (const value of ['0', '65536', 'wrong', '1.2', '']) {
            expect(() => localPorts({ CONVEX_LOCAL_CLOUD_PORT: value })).toThrow('Invalid local Convex port');
        }
        expect(() => localPorts({ CONVEX_LOCAL_CLOUD_PORT: '3211' })).toThrow('ports must differ');
    });
});
