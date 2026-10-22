// 全量分页。接口不前进时明确失败，不能将截断列表当成完整列表。
export async function allPages(fetchPage, { size, key }) {
  const rows = [], ids = new Set();
  for (let page = 1; ; page++) {
    const data = await fetchPage(page, size);
    if (!Array.isArray(data?.items)) throw new Error('分页接口未返回 items 数组');
    const batch = data.items;
    for (const row of batch) {
      const id = row[key];
      if (id == null || ids.has(String(id))) throw new Error('分页结果重复或缺少标识，请重新同步');
      ids.add(String(id)); rows.push(row);
    }
    if (batch.length < size) return rows;
    if (page >= 10000) throw new Error('分页超过保护上限，请缩小查询范围');
  }
}
