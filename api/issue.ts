import { issueDetail } from './_store';

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: '缺少 Issue ID。' }, { status: 400 });
  const item = await issueDetail(id);
  return item ? Response.json(item) : Response.json({ error: '云端数据中未找到此 Issue。' }, { status: 404 });
}
