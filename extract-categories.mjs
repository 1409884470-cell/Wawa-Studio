// 从站点提取类目树 + 标签库（走接口）+ 投稿入口
import { createRunner } from './core.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runner = createRunner({ onLog: (l) => console.log(l) });
try {
  await runner.launch({ headless: true });
  await runner.ensureLogin({ loginWait: 120 });
  const page = runner.page;

  // ---- 类目树（级联点击） ----
  await page.goto('https://wawawriter.com/app/submission/create', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const menus = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('.el-cascader__dropdown .el-cascader-menu'))
      .map(m => Array.from(m.querySelectorAll('.el-cascader-node')).map(n => n.textContent.trim()))
  );
  await page.getByRole('textbox', { name: '请选择小说类目（一级/二级/三级）' }).click();
  await page.waitForTimeout(700);
  const l1 = (await menus())[0] ?? [];
  const tree = {};
  for (const a of l1) {
    tree[a] = {};
    await page.getByRole('menuitem', { name: a }).first().click();
    await page.waitForTimeout(500);
    const l2 = (await menus())[1] ?? [];
    for (const b of l2) {
      await page.getByRole('menuitem', { name: b }).first().click();
      await page.waitForTimeout(450);
      const cols = await menus();
      tree[a][b] = cols[2] ?? [];
      await page.getByRole('menuitem', { name: a }).first().click();
      await page.waitForTimeout(350);
    }
    console.log(`类目 ${a}：${Object.keys(tree[a]).length} 个二级`);
  }
  await page.keyboard.press('Escape');

  // ---- 标签库：展开标签区后从 DOM 抓全量 ----
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const ex = btns.find(b => b.textContent.trim() === '展开');
    if (ex) ex.click();
  });
  await page.waitForTimeout(600);
  const tags = await page.evaluate(() => {
    const c = document.querySelector('div.flex.flex-wrap.gap-2');
    return c ? Array.from(c.children).map(e => e.textContent.trim()) : [];
  });

  // ---- 投稿入口 ----
  const entries = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.el-radio__label')).map(e => e.textContent.trim())
      .filter(t => t.includes('投稿') || t.includes('征文'))
  );

  const data = { entries: [...new Set(entries)], tags, tree, extractedAt: new Date().toISOString() };
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'categories.json'), JSON.stringify(data, null, 2));
  console.log('保存完成：入口', data.entries.length, '个；标签', data.tags.length, '个');
} finally {
  await runner.close();
}
