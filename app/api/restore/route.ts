import { NextRequest } from "next/server";
import { restoreSeat } from "../../../lib/engine";
import { checkOrigin, failure, tokenResponse } from "../../../lib/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
    try {
        checkOrigin(request);
        const { token } = await request.json();
        await restoreSeat(token);
        return tokenResponse(token);
    }
    catch (error) {
        return failure(error);
    }
}
