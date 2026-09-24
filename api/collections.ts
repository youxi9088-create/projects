import { recentCollections } from './_store';

export async function GET() { return Response.json({ collections: await recentCollections() }); }
