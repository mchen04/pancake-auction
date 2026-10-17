export const dynamic = 'force-static';

export function GET() {
  return Response.json({ version: process.env.APP_VERSION });
}
