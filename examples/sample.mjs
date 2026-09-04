export async function pruneStale(zone, token, declared) {
  const res = await fetch(`https://api.example.com/zones/${zone}/records?per_page=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const live = (await res.json()).result;
  const declaredIds = new Set(declared.map((d) => d.id));
  const doomed = live.filter((r) => !declaredIds.has(r.id));
  for (const r of doomed) {
    await fetch(`https://api.example.com/zones/${zone}/records/${r.id}`, { method: "DELETE" });
  }
  return doomed.length;
}
