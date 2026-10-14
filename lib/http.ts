import { NextRequest, NextResponse } from "next/server";
import { RuleError } from "./engine";
export function requestToken(request: NextRequest) {
    return request.cookies.get("pancake-seat")?.value || request.headers.get("authorization")?.replace(/^Bearer /, "");
}
export function checkOrigin(request: NextRequest) {
    const origin = request.headers.get("origin");
    if (origin) {
        let host: string;
        try {
            host = new URL(origin).host;
        }
        catch {
            throw new RuleError("Request origin does not match", 403);
        }
        if (host !== request.headers.get("host")) {
            throw new RuleError("Request origin does not match", 403);
        }
    }
}
export function tokenResponse(token: string) {
    const response = NextResponse.json({
        token
    }, {
        headers: {
            "Cache-Control": "no-store"
        }
    });
    response.cookies.set("pancake-seat", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production" && process.env.SEAT_COOKIE_SECURE !== "false",
        path: "/",
        maxAge: 60 * 60 * 24 * 365
    });
    return response;
}
export function failure(error: unknown) {
    if (error instanceof RuleError) {
        return NextResponse.json({
            error: error.message
        }, {
            status: error.status
        });
    }
    if (error instanceof SyntaxError) {
        return NextResponse.json({
            error: "Send valid JSON"
        }, {
            status: 422
        });
    }
    const message = error instanceof Error
        ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]") : "Unknown error";
    console.error("Auction request failed", message);
    return NextResponse.json({
        error: "The server cannot finish this request. Try again."
    }, {
        status: 500
    });
}
