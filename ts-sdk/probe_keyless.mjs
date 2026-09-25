import { init, Cognee } from '@cognee/cognee-ts';

init();
const c = new Cognee({});
try {
  await c.warm();
  console.log('warm OK, owner:', await c.ownerId());
} catch (e) {
  console.log('warm failed:', e?.name ?? 'Error', '-', String(e?.message ?? e).slice(0, 200));
  process.exit(0);
}
try {
  const add = await c.add({ type: 'text', text: 'Hello proof. Alice prefers Friday reports.' }, 'tsproof');
  console.log('add OK:', JSON.stringify(add).slice(0, 150));
  const cog = await c.cognify('tsproof');
  console.log('cognify OK:', JSON.stringify(cog).slice(0, 150));
  const res = await c.search('weekly reports', { searchType: 'CHUNKS' });
  console.log('search OK:', JSON.stringify(res).slice(0, 200));
} catch (e) {
  console.log('pipeline failed:', e?.name ?? 'Error', '-', String(e?.message ?? e).slice(0, 300));
}
