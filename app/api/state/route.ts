import { NextRequest, NextResponse } from "next/server";
import { getState } from "../../../lib/engine";
import { failure, requestToken } from "../../../lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
    try {
        const state = await getState(requestToken(request));
        if (request.nextUrl.searchParams.get("players") === "0") {
            state.players = [];
        }
        return NextResponse.json(state, {
            headers: {
                "Cache-Control": "no-store"
            }
        });
    }
    catch (error) {
        return failure(error);
    }
}
