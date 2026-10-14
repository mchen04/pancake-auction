import { NextRequest } from "next/server";
import { claimSeat } from "../../../lib/engine";
import { checkOrigin, failure, tokenResponse } from "../../../lib/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
    try {
        checkOrigin(request);
        const { managerId } = await request.json();
        return tokenResponse(await claimSeat(managerId));
    }
    catch (error) {
        return failure(error);
    }
}
