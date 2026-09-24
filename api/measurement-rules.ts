import { measurementRulesPayload } from '../src/measurement-rules.js';

export async function GET() { return Response.json({ rules: measurementRulesPayload() }); }
