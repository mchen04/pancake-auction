import { NextRequest, NextResponse } from "next/server";
import { act, RuleError } from "../../../lib/engine";
import { checkOrigin, failure, requestToken } from "../../../lib/http";
import type { Action } from "../../../lib/types";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
    try {
        checkOrigin(request);
        const action = await request.json();
        if (!action || typeof action !== "object" || ![
            "start",
            "pause",
            "resume",
            "undo",
            "force",
            "release",
            "nominate",
            "bid",
            "pass",
            "place",
            "done"
        ].includes(action.type)) {
            throw new RuleError("Unknown action");
        }
        if (["bid", "pass", "force"].includes(action.type) && (!Number.isSafeInteger(action.lotId)
            || action.lotId < 1)) {
            throw new RuleError("Send the current lot ID");
        }
        if (["bid", "nominate"].includes(action.type) && (!Number.isSafeInteger(action.amount) || action.amount < 1)) {
            throw new RuleError("Bid a whole dollar of at least $1");
        }
        if (["nominate", "place"].includes(action.type) && (typeof action.playerId !== "string"
            || !action.playerId || action.playerId.length > 100)) {
            throw new RuleError("Send a player ID");
        }
        if (action.type === "release" && (!Number.isSafeInteger(action.managerId) || action.managerId < 1)) {
            throw new RuleError("Send a configured manager ID");
        }
        await act(action as Action, requestToken(request));
        return NextResponse.json({
            ok: true
        });
    }
    catch (error) {
        return failure(error);
    }
}
