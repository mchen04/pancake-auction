let payload = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => payload += chunk);
process.stdin.on("end", async () => {
    try {
        const { base, token, managerId } = JSON.parse(payload);
        const response = await fetch(`${base}/api/restore`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                token
            })
        });
        if (!response.ok) {
            throw new Error("Reconnect restore failed");
        }
        const cookie = response.headers.get("set-cookie")!.split(";")[0];
        const state = await (await fetch(`${base}/api/state`, {
            headers: {
                Cookie: cookie
            }
        })).json();
        if (state.me !== managerId) {
            throw new Error("Reconnect identity mismatch");
        }
        process.stdout.write(JSON.stringify({
            cookie,
            me: state.me
        }));
    }
    catch {
        process.exitCode = 1;
    }
});
