import { healthTrend } from './_store';

export async function GET(request: Request) {
  const requested = Number(new URL(request.url).searchParams.get('hours'));
  const hours = requested === 168 ? 168 : 24;
  return Response.json({ trend: await healthTrend(hours) });
}
