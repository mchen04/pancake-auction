export function localPorts(environment: Record<string, string | undefined>) {
    const parse = (value: string | undefined, fallback: number) => {
        const port = value === undefined ? fallback : Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local Convex port');
        return port;
    };
    const cloud = parse(environment.CONVEX_LOCAL_CLOUD_PORT, 3210);
    const site = parse(environment.CONVEX_LOCAL_SITE_PORT, 3211);
    if (cloud === site) throw new Error('Local Convex ports must differ');
    return { cloud, site };
}
